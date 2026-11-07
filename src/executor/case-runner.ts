import { errMessage } from '../errors.js';
import type { ActionT, AttemptT, CaseT, FailureT, SiteProfile } from '../contracts/index.js';
import type { FixtureScope } from '../fixture/manager.js';
import { render } from '../fixture/template.js';
import type { ArtifactWriter } from '../io/artifact-writer.js';
import type { Logger } from '../log/logger.js';
import { evaluateInvariants, evaluateOracle, type OracleOutcome } from '../oracle/engine.js';
import { resolveSecret } from '../security/secrets.js';
import { raceAbort } from './abort.js';
import type { BrowserSession, ExecAction, PageEvent, PageSession } from './adapter.js';
import { buildRequestPolicy } from './guards.js';
import { attemptVerdict } from './verdict.js';

export interface AttemptDeps {
  profile: SiteProfile;
  session: BrowserSession;
  scope: FixtureScope;
  writer: ArtifactWriter;
  logger: Logger;
  signal: AbortSignal;
}

export async function runAttempt(d: AttemptDeps, c: CaseT, attempt: number): Promise<AttemptT & { faults: string[] }> {
  const started = Date.now();
  const { profile, logger } = d;
  const limits = profile.limits;
  const failures: FailureT[] = [];
  const assertions: AttemptT['failed_assertions'] = [];
  const notes: string[] = [];
  const faults: string[] = [];
  const events: PageEvent[] = [];
  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.parameters)) vars[`param.${k}`] = String(v);

  let phase: 'setup' | 'steps' | 'oracles' = 'setup';
  let authPhase = false;
  let blocked: { reason: string } | undefined;
  let timedOut: 'setup' | 'steps' | undefined;
  let actionFailed = false;
  let notEvaluable = 0;
  let violations = 0;
  let settled = true;
  let blockedRequests = 0;
  let page: PageSession | undefined;

  const ctrl = new AbortController();
  const onParent = () => ctrl.abort('parent');
  d.signal.addEventListener('abort', onParent, { once: true });
  if (d.signal.aborted) ctrl.abort('parent');
  const timer = setTimeout(() => {
    timedOut = phase === 'setup' ? 'setup' : 'steps';
    ctrl.abort('timeout');
  }, limits.case_timeout_ms);
  const signal = ctrl.signal;

  const drain = (): void => {
    if (!page) return;
    for (const e of page.drainEvents()) {
      if (events.length < limits.max_events_per_attempt * 2) events.push(e);
      if (e.kind === 'blocked') {
        blockedRequests++;
        logger.warn('request_blocked', { url: e.url, method: e.method, reason: e.reason });
        if (e.reason === 'UNOWNED_MUTATION') blocked = { reason: 'UNOWNED_MUTATION' };
      }
    }
  };
  const resolve = (s: string): string => render(s, vars);
  const exec = async (a: ActionT): Promise<boolean> => {
    if (a.type === 'fixture') {
      try {
        const r = await raceAbort(d.scope.create(a.kind), signal);
        vars[`fixture.${a.as}.name`] = r.name;
        vars[`fixture.${a.as}.id`] = r.id;
        return true;
      } catch (e) {
        if (!signal.aborted) {
          blocked = { reason: 'FIXTURE_FAILED' };
          failures.push({ source: 'setup', name: `fixture:${a.kind}`, phase: 'setup', reason_code: 'FIXTURE_FAILED', message: errMessage(e).slice(0, 300) });
        }
        return false;
      }
    }
    const act: ExecAction =
      a.type === 'navigate' ? { type: 'navigate', url: new URL(resolve(a.path), profile.base_url).href }
      : a.type === 'fill' ? { type: 'fill', target: a.target, value: a.value_ref ? resolveSecret(a.value_ref) : resolve(a.value ?? '') }
      : a.type === 'wait_for' ? { type: 'wait_for', ...(a.text ? { text: resolve(a.text) } : {}), ...(a.target ? { target: a.target } : {}), timeout_ms: a.timeout_ms }
      : a.type === 'select' ? { type: 'select', target: a.target, option: resolve(a.option) }
      : a.type === 'click' ? { type: 'click', target: a.target }
      : { type: 'press', key: a.key };
    const out = await raceAbort((page as PageSession).perform(act, signal), signal);
    drain();
    return out.ok || ((actionFailed = true), failures.push({ source: 'action', name: a.type, phase, reason_code: 'ACTION_FAILED', message: (out.error ?? 'action failed').slice(0, 300) }), false);
  };

  try {
    if (c.mutating && profile.environment === 'production') {
      blocked = { reason: 'MUTATION_ON_PRODUCTION' };
      failures.push({ source: 'setup', name: 'environment_guard', phase: 'setup', reason_code: 'MUTATION_ON_PRODUCTION', message: 'mutating case refused on production' });
    } else {
      const policy = buildRequestPolicy(profile, { caseMutating: c.mutating, authPhase: () => authPhase, owned: () => d.scope.ownedIdentifiers() });
      page = await raceAbort(d.session.newContext(policy), signal);
      const auth = profile.auth;
      if (auth.strategy === 'form_login') {
        authPhase = true;
        const ok =
          (await exec({ type: 'navigate', path: auth.login_path })) &&
          (await exec({ type: 'fill', target: auth.username_target, value_ref: auth.username_ref })) &&
          (await exec({ type: 'fill', target: auth.password_target, value_ref: auth.password_ref })) &&
          (await exec({ type: 'click', target: auth.submit_target })) &&
          (!auth.success_text || (await page.hasText(auth.success_text)));
        authPhase = false;
        if (!ok && !blocked) {
          blocked = { reason: 'AUTH_FIXTURE_FAILED' };
          failures.length = 0;
          actionFailed = false;
          failures.push({ source: 'setup', name: 'login', phase: 'setup', reason_code: 'AUTH_FIXTURE_FAILED', message: 'login fixture failed' });
        }
      }
      let firstNonFixtureSeen = false;
      for (const step of c.steps) {
        if (blocked || signal.aborted) break;
        if (step.type !== 'fixture' && !firstNonFixtureSeen) { firstNonFixtureSeen = true; phase = 'steps'; }
        if (!(await exec(step))) break;
        if (blocked) break;
      }
      phase = 'steps';
      if (!blocked && !signal.aborted && !actionFailed) {
        settled = await raceAbort(page.settle(Math.min(5000, limits.case_timeout_ms)), signal).catch(() => false);
        drain();
      }
    }
  } catch (e) {
    if (!signal.aborted) {
      actionFailed = true;
      failures.push({ source: 'action', name: 'executor', phase, reason_code: 'EXECUTOR_ERROR', message: errMessage(e).slice(0, 300) });
    }
  }

  // Oracle phase: runs even after timeout/abort/action failure so established violations are preserved.
  phase = 'oracles';
  if (page && !blocked) {
    try {
      drain();
      const st = await Promise.race([page.state(), new Promise<never>((_r, rej) => setTimeout(() => rej(new Error('state timeout')), 3000).unref())]).catch(() => undefined);
      const evaluable = !actionFailed && !signal.aborted && !timedOut;
      const ctx = { page, events, invariants: profile.invariants, evaluable, mainStatus: st?.main_status ?? null };
      const outcomes: OracleOutcome[] = [];
      for (const o of c.oracles) outcomes.push(await evaluateOracle({ ...o, ...(o.type === 'text_visible' ? { text: resolve(o.text) } : {}) } as typeof o, ctx));
      outcomes.push(...evaluateInvariants(ctx));
      for (const o of outcomes) {
        if (o.status === 'VIOLATED') {
          violations++;
          assertions.push({ oracle: o.name, expected: o.expected, actual: o.actual });
          failures.push({
            source: o.name.startsWith('invariant:') ? 'invariant' : 'oracle', name: o.name, phase: 'oracles',
            ...(o.http_status !== undefined ? { http_status: o.http_status } : {}),
            message: JSON.stringify({ expected: o.expected, actual: o.actual }).slice(0, 300),
          });
        } else if (o.status === 'NOT_EVALUABLE') notEvaluable++;
      }
    } catch (e) {
      notEvaluable++;
      notes.push(`oracle_phase_error:${errMessage(e).slice(0, 100)}`);
    }
  }
  clearTimeout(timer);
  d.signal.removeEventListener('abort', onParent);
  if (timedOut) failures.push({ source: 'timeout', name: 'case_timeout', phase: timedOut, reason_code: 'CASE_TIMEOUT', message: `case exceeded ${limits.case_timeout_ms}ms` });
  if (d.signal.aborted) failures.push({ source: 'abort', name: 'abort', phase, reason_code: 'ABORTED', message: String(d.signal.reason ?? 'aborted') });

  // Close the browser context first, then teardown (always, bounded).
  if (page) await Promise.race([page.close(), new Promise((r) => setTimeout(r, 5000).unref())]).catch(() => undefined);
  const td = await d.scope.teardownAll().catch((e) => { notes.push(`teardown_error:${errMessage(e).slice(0, 100)}`); return { done: 0, noop: 0, quarantined: 0 }; });
  if (td.quarantined > 0) notes.push(`QUARANTINED:${td.quarantined}`);

  const v = attemptVerdict({ ...(blocked ? { blocked } : {}), ...(timedOut ? { timedOut } : {}), aborted: d.signal.aborted, violations, notEvaluable, actionFailed, settled });
  const evidence = [];
  try {
    const w = d.writer.writeEvidence('events', c.case_id, attempt, { attempt, events: events.slice(0, limits.max_events_per_attempt), failures });
    if (w.truncated) notes.push('ARTIFACT_CAP');
    evidence.push({ kind: 'events', file: w.file, bytes: w.bytes, truncated: w.truncated });
  } catch (e) {
    faults.push('ARTIFACT_FAULT');
    notes.push(`artifact_error:${errMessage(e).slice(0, 100)}`);
  }
  logger.info('attempt_verdict', { verdict: v.verdict, reason_code: v.reason_code, attempt, case_id: c.case_id });
  return {
    attempt, verdict: v.verdict, ...(v.reason_code ? { reason_code: v.reason_code } : {}),
    fixture_ids: d.scope.keysCreated(), failures, failed_assertions: assertions, evidence,
    blocked_requests: blockedRequests, notes, duration_ms: Date.now() - started, faults,
  };
}
