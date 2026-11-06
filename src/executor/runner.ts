import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { comparisonConfigId, digest } from '../compare/hash.js';
import { SCHEMA_VERSION, RunResultsSchema, type CaseResultT, type CaseRegistry, type RunManifest, type RunResults, type SiteProfile } from '../contracts/index.js';
import { resolvePolicy, type GatePolicy } from '../contracts/gate-policy.js';
import { FixtureManager } from '../fixture/manager.js';
import { Ledger, type Owner } from '../fixture/ledger.js';
import { RunLock } from '../fixture/runlock.js';
import { evaluateGate } from '../gate/evaluate.js';
import { ArtifactWriter } from '../io/artifact-writer.js';
import { Logger, fileSink, stderrSink } from '../log/logger.js';
import { buildPlan, planDigest } from '../registry/select.js';
import { renderHtml } from '../report/html.js';
import { renderJunit } from '../report/junit.js';
import { computeMetrics } from '../report/metrics.js';
import { redactor } from '../security/redactor.js';
import { maskRef, resolveSecret } from '../security/secrets.js';
import type { HttpClient } from '../security/http.js';
import { RULES_VERSION, triageResult } from '../triage/classifier.js';
import { TOOL_VERSION } from '../version.js';
import type { BrowserAdapter } from './adapter.js';
import { runAttempt } from './case-runner.js';
import { aggregateAttempts, shouldRetry } from './verdict.js';
import { resolveInside } from '../security/paths.js';

export interface RunOptions {
  profile: SiteProfile;
  registry: CaseRegistry;
  policy?: GatePolicy;
  adapter: BrowserAdapter;
  http: HttpClient;
  outRoot: string;
  retries?: number;
  workers?: number;
  shardId?: string;
  caseIds?: string[];
  signal?: AbortSignal;
  stderr?: boolean;
  runId?: string;
}
export interface RunOutput { results: RunResults; manifest: RunManifest; runDir: string }

const ULID_CHARS = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function ulid(now = Date.now()): string {
  let t = now, ts = '';
  for (let i = 0; i < 10; i++) { ts = ULID_CHARS[t % 32] + ts; t = Math.floor(t / 32); }
  return ts + Array.from(randomBytes(16)).slice(0, 16).map((b) => ULID_CHARS[b % 32]).join('');
}

export async function runSuite(o: RunOptions): Promise<RunOutput> {
  const { profile } = o;
  const startedMs = Date.now();
  const runId = o.runId ?? ulid();
  const shardId = o.shardId ?? 's0';
  const retries = Math.min(o.retries ?? profile.limits.max_retries, profile.limits.max_retries, 5);
  const workers = Math.min(o.workers ?? 1, profile.limits.max_workers);
  const runDir = resolveInside(o.outRoot, join('runs', runId));
  const resolvedPolicy = resolvePolicy(o.policy);
  const writer = new ArtifactWriter(runDir, redactor, { perCaseBytes: profile.limits.max_artifact_bytes_per_case, totalBytes: 256 * 1024 * 1024 });
  const logger = new Logger(runId, [...(o.stderr ? [stderrSink] : []), fileSink(join(runDir, 'run.log'))]).child({ component: 'runner' });
  const lock = new RunLock(runDir);
  lock.acquire();
  const faults: string[] = [];

  // Secrets are resolved (and registered with the redactor) before any output can exist.
  const refs = new Set<string>();
  if (profile.auth.strategy === 'form_login') { refs.add(profile.auth.username_ref); refs.add(profile.auth.password_ref); }
  for (const f of Object.values(profile.fixtures)) for (const r of [f.create, f.teardown, f.lookup]) if (r?.auth_ref) refs.add(r.auth_ref);
  for (const c of o.registry.cases) for (const s of c.steps) if (s.type === 'fill' && s.value_ref) refs.add(s.value_ref);

  const planned = buildPlan(o.registry, o.caseIds ? { case_ids: o.caseIds } : {});
  const plan = planned.map((p) => p.entry);
  const oracles = Object.fromEntries(planned.map((p) => [p.entry.case_id, { o: p.case.oracles, s: p.case.steps, m: p.case.mutating }]));
  const cfgId = comparisonConfigId({
    browser: profile.browser, invariants: profile.invariants,
    limits: { case_timeout_ms: profile.limits.case_timeout_ms, run_timeout_ms: profile.limits.run_timeout_ms },
    triage_rules: profile.triage?.rules ?? [], triage_rules_version: RULES_VERSION, oracles, retries, policy: resolvedPolicy,
  });
  const manifest: RunManifest = {
    schema_version: SCHEMA_VERSION, run_id: runId, site_id: profile.site_id, tool_version: TOOL_VERSION, comparison_config_id: cfgId,
    started_at: new Date(startedMs).toISOString(), selection: o.caseIds ? { case_ids: o.caseIds } : {}, shard_id: shardId, workers, retries,
    secrets: [...refs].sort().map(maskRef), plan, plan_digest: planDigest(plan), registry_digest: digest(o.registry),
    policy_digest: digest(resolvedPolicy), profile_digest: digest(profile),
  };
  logger.info('run_start', { run_id: runId, planned: plan.length, workers, retries });

  const root = new AbortController();
  const onExt = () => root.abort(o.signal?.reason ?? 'ABORT');
  o.signal?.addEventListener('abort', onExt, { once: true });
  if (o.signal?.aborted) onExt();
  const runTimer = setTimeout(() => { faults.push('RUN_TIMEOUT'); root.abort('RUN_TIMEOUT'); }, profile.limits.run_timeout_ms);

  const ledger = new Ledger(join(runDir, 'ledger.jsonl'));
  const results = new Map<string, CaseResultT>();
  let session: Awaited<ReturnType<BrowserAdapter['launch']>> | undefined;
  try {
    for (const r of refs) resolveSecret(r);
    writer.writeNamed('manifest.json', JSON.stringify(manifest, null, 2));
    const fm = new FixtureManager({
      runId, siteId: profile.site_id, baseUrl: profile.base_url, fixtures: profile.fixtures, ledger, http: o.http, logger,
      resolveSecret, teardownTimeoutMs: profile.limits.teardown_timeout_ms,
    });
    const queue = planned.filter((p) => p.entry.blocking_eligible);
    for (const p of planned) {
      if (!p.entry.blocking_eligible) results.set(p.entry.case_id, baseResult(p.entry, 'SKIPPED', 'NOT_EXECUTABLE_STATE'));
    }
    session = queue.length > 0
      ? await o.adapter.launch({ viewport: profile.browser.viewport, locale: profile.browser.locale, timezone: profile.browser.timezone, allowedOrigins: profile.allowed_origins, maxEvents: profile.limits.max_events_per_attempt })
      : undefined;
    const next = [...queue];
    const worker = async (idx: number): Promise<void> => {
      for (let p = next.shift(); p; p = next.shift()) {
        if (root.signal.aborted) { results.set(p.entry.case_id, baseResult(p.entry, 'NON_ESEGUITO', 'NOT_ATTEMPTED')); continue; }
        const t0 = Date.now();
        const attempts = [];
        for (let k = 1; k <= 1 + retries; k++) {
          const owner: Owner = { run_id: runId, shard_id: shardId, worker_id: `w${idx}`, case_id: p.case.case_id, attempt: k };
          const a = await runAttempt({ profile, session: session as NonNullable<typeof session>, scope: fm.scope(owner), writer, logger: logger.child({ worker_id: owner.worker_id, case_id: owner.case_id, shard_id: shardId }), signal: root.signal }, p.case, k);
          faults.push(...a.faults);
          const { faults: _f, ...att } = a;
          attempts.push(att);
          if (!shouldRetry(att) || root.signal.aborted) break;
        }
        const agg = aggregateAttempts(attempts);
        const rep = attempts[agg.representative];
        const res: CaseResultT = {
          ...baseResult(p.entry, agg.verdict, agg.reason_code), flaky: agg.flaky, attempts,
          failed_assertions: rep?.failed_assertions ?? [], evidence: attempts.flatMap((a) => a.evidence), duration_ms: Date.now() - t0,
        };
        const tri = triageResult(res, agg.representative, profile.triage?.rules);
        if (tri) { res.triage = tri; logger.info('triage', { case_id: res.case_id, class: tri.class, rule_id: tri.rule_id }); }
        logger.info('verdict', { case_id: res.case_id, verdict: res.verdict, flaky: res.flaky });
        results.set(res.case_id, res);
      }
    };
    await Promise.all(Array.from({ length: workers }, (_v, i) => worker(i)));
  } catch (e) {
    faults.push('RUN_FAULT');
    logger.error('run_fault', { message: (e as Error).message.slice(0, 200) });
    for (const p of planned) if (!results.has(p.entry.case_id)) results.set(p.entry.case_id, baseResult(p.entry, 'NON_ESEGUITO', 'NOT_ATTEMPTED'));
  } finally {
    clearTimeout(runTimer);
    o.signal?.removeEventListener('abort', onExt);
    if (session) await session.close().catch(() => undefined);
  }
  if (root.signal.aborted && !faults.includes('RUN_TIMEOUT')) faults.push('RUN_ABORTED');
  if (logger.hasFault) faults.push('LOG_FAULT');
  for (const p of planned) if (!results.has(p.entry.case_id)) results.set(p.entry.case_id, baseResult(p.entry, 'NON_ESEGUITO', 'NOT_ATTEMPTED'));

  const sorted = [...results.values()].sort((a, b) => a.case_id.localeCompare(b.case_id));
  const quarantined = ledger.quarantined().map((q) => ({ resource_key: q.resource_key, kind: q.kind, name: q.name, owner_case_id: q.owner.case_id, reason: q.reason ?? 'teardown failed' }));
  const finishedMs = Date.now();
  const uniqueFaults = [...new Set(faults)];
  const gate = evaluateGate({ plan, plan_digest: manifest.plan_digest, results: sorted, faults: uniqueFaults }, resolvedPolicy);
  const final: RunResults = {
    schema_version: SCHEMA_VERSION, run_id: runId, site_id: profile.site_id, tool_version: TOOL_VERSION, comparison_config_id: cfgId,
    started_at: manifest.started_at, finished_at: new Date(finishedMs).toISOString(), plan, plan_digest: manifest.plan_digest,
    faults: uniqueFaults, gate, results: sorted, quarantined, summary: computeMetrics(sorted, quarantined.length, finishedMs - startedMs),
  };
  logger.info('gate_decision', { decision: gate.decision });
  try {
    RunResultsSchema.parse(final);
    writer.writeNamed('results.json', JSON.stringify(final, null, 2));
    writer.writeNamed('junit.xml', renderJunit(final));
    writer.writeNamed('report.html', renderHtml(final));
  } catch (e) {
    // Fail closed: reports could not be persisted safely.
    final.faults.push('REPORT_FAULT');
    final.gate = { decision: 'INCONCLUSIVE', reasons: [{ code: 'REPORT_FAULT', message: (e as Error).message.slice(0, 200), effect: 'INCONCLUSIVE' }] };
  }
  logger.info('run_end', { run_id: runId });
  lock.release();
  return { results: final, manifest, runDir };
}

function baseResult(p: { case_id: string; case_revision: number; parameter_set_id: string }, verdict: CaseResultT['verdict'], reason?: string): CaseResultT {
  return { case_id: p.case_id, case_revision: p.case_revision, parameter_set_id: p.parameter_set_id, verdict, ...(reason ? { reason_code: reason } : {}), flaky: false, attempts: [], failed_assertions: [], evidence: [], duration_ms: 0 };
}
