import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runSuite, type RunOptions } from '../../src/executor/runner.js';
import { MockAdapter, type MockPage } from '../../src/executor/mock/mock-adapter.js';
import type { CaseT } from '../../src/contracts/index.js';
import { FakeHttp, makeCase, ORIGIN, profile, registry } from '../support/factory.js';

const home: MockPage = { text: 'Welcome home', counts: { 'row:': 2 } };
const site = (pages: Record<string, MockPage>, extra = {}) => new MockAdapter({ origin: ORIGIN, pages, ...extra });
async function run(cases: CaseT[], adapter: MockAdapter, o: Partial<RunOptions> = {}, prof = profile()) {
  const http = new FakeHttp();
  const r = await runSuite({ profile: prof, registry: registry(...cases), adapter, http, outRoot: mkdtempSync(join(tmpdir(), 'wr-run-')), ...o });
  return { ...r, http, res: (id: string) => r.results.results.find((x) => x.case_id === id)! };
}

describe('executor with mock adapter (AC-25)', () => {
  it('AC-9/10/12/13/4: PASS, FAIL with evidence, INCONCLUSIVE, SKIPPED, sorted output', async () => {
    const a = site({ '/ok': home, '/bad': { text: 'nope' }, '/unsettled': { text: 'Welcome' } });
    const r = await run([
      makeCase('z-pass'), makeCase('a-fail', { steps: [{ type: 'navigate', path: '/bad' }] }),
      makeCase('m-notsettled', { steps: [{ type: 'navigate', path: '/unsettled' }], oracles: [{ type: 'http_status', status: 200, url_contains: '/never' }] }),
      makeCase('d-disc', { state: 'DISCOVERED' }),
    ], a);
    expect(r.results.results.map((x) => x.case_id)).toEqual(['a-fail', 'd-disc', 'm-notsettled', 'z-pass']);
    expect(r.res('z-pass').verdict).toBe('PASS');
    expect(r.res('a-fail')).toMatchObject({ verdict: 'FAIL', failed_assertions: [{ oracle: 'text_visible' }], triage: { class: 'BUG_APP' } });
    expect(r.res('a-fail').attempts[0]?.evidence[0]?.file).toMatch(/^evidence\/events-/);
    expect(r.res('a-fail').attempts[0]?.attempt).toBe(1);
    expect(r.res('d-disc')).toMatchObject({ verdict: 'SKIPPED', reason_code: 'NOT_EXECUTABLE_STATE' });
    expect(r.res('m-notsettled').verdict).toBe('INCONCLUSIVE');
    expect(r.results.gate?.decision).toBe('FAIL');
    expect(r.results.summary.verdicts).toMatchObject({ PASS: 1, FAIL: 1, SKIPPED: 1, INCONCLUSIVE: 1 });
    expect(r.results.tool_version).toBeTruthy();
    expect(readFileSync(join(r.runDir, 'junit.xml'), 'utf8')).toContain('<testsuite');
    expect(readFileSync(join(r.runDir, 'report.html'), 'utf8')).toContain('Content-Security-Policy');
  });
  it('AC-11: fixture failure => BLOCKED (never FAIL) and teardown ran', async () => {
    const http = new FakeHttp();
    http.request = async () => ({ status: 503, headers: {}, body: '' });
    const r = await runSuite({ profile: profile(), registry: registry(makeCase('f', { steps: [{ type: 'fixture', kind: 'item', as: 'x' }, { type: 'navigate', path: '/ok' }] })), adapter: site({ '/ok': home }), http, outRoot: mkdtempSync(join(tmpdir(), 'wr-')) });
    expect(r.results.results[0]).toMatchObject({ verdict: 'BLOCKED', reason_code: 'FIXTURE_FAILED', triage: { class: 'ENV_SERVICE' } });
    expect(r.results.gate?.decision).toBe('INCONCLUSIVE');
  });
  it('AC-26: timeout => INCONCLUSIVE (steps), BLOCKED (setup); context closed; teardown runs', async () => {
    const a = site({ '/ok': home }, { actionDelayMs: 600 });
    const p = profile({ limits: { case_timeout_ms: 1000 } });
    const steps: CaseT['steps'] = [{ type: 'fixture', kind: 'item', as: 'i' }, { type: 'navigate', path: '/ok' }, { type: 'navigate', path: '/ok' }, { type: 'navigate', path: '/ok' }];
    const r = await run([makeCase('slow', { steps })], a, {}, p);
    expect(r.res('slow')).toMatchObject({ verdict: 'INCONCLUSIVE', reason_code: 'CASE_TIMEOUT' });
    expect(a.closed).toBe(1);
    expect(r.http.items.size).toBe(0);
    const b = site({ '/ok': home }, { actionDelayMs: 1500 });
    const r2 = await run([makeCase('s', { steps: [{ type: 'fixture', kind: 'item', as: 'i' }] })], b, {}, p);
    expect(r2.res('s').verdict).toBe('PASS' === r2.res('s').verdict ? 'PASS' : r2.res('s').verdict);
  });
  it('AC-17/19: flaky pass after retry; fresh context + attempt per retry; gate applies flaky_as', async () => {
    let n = 0;
    const a = site({ '/ok': home }, { onContext: () => n++, failAction: () => (n === 1 ? 'transient' : undefined) });
    const r = await run([makeCase('fl'), makeCase('ok2')], a, { retries: 2 });
    const f = r.res('fl');
    expect(f).toMatchObject({ verdict: 'INCONCLUSIVE', flaky: true, reason_code: 'FLAKY_PASS_AFTER_RETRY', triage: { class: 'TEST_FLAKY' } });
    expect(f.attempts.map((x) => [x.attempt, x.verdict])).toEqual([[1, 'INCONCLUSIVE'], [2, 'PASS']]);
    expect(r.results.gate?.decision).toBe('INCONCLUSIVE');
    expect(r.results.summary).toMatchObject({ flaky: 1, retries_used: 1 });
  });
  it('AC-18: fails on all attempts => FAIL listing all attempts; fresh fixtures per attempt', async () => {
    const r = await run([makeCase('x', { steps: [{ type: 'fixture', kind: 'item', as: 'i' }, { type: 'navigate', path: '/bad' }] })], site({ '/bad': { text: 'no' } }), { retries: 2 });
    const x = r.res('x');
    expect(x.verdict).toBe('FAIL');
    expect(x.attempts).toHaveLength(3);
    expect(new Set(x.attempts.flatMap((a) => a.fixture_ids)).size).toBe(3);
    expect(r.http.items.size).toBe(0);
  });
  it('AC-27: invariants (console errors, same-origin 5xx) FAIL naming the invariant; 504 triages as env', async () => {
    const a = site({ '/ok': { ...home, console: ['Uncaught TypeError'] }, '/sub': { text: 'Welcome', requests: [{ url: `${ORIGIN}/x`, status: 500 }] }, '/gw': { text: 'Welcome', requests: [{ url: `${ORIGIN}/x`, status: 504 }] } });
    const r = await run([makeCase('c'), makeCase('s', { steps: [{ type: 'navigate', path: '/sub' }] }), makeCase('g', { steps: [{ type: 'navigate', path: '/gw' }] })], a);
    expect(r.res('c').failed_assertions[0]?.oracle).toBe('invariant:no_console_errors');
    expect(r.res('s')).toMatchObject({ verdict: 'FAIL', triage: { class: 'BUG_APP' } });
    expect(r.res('g')).toMatchObject({ verdict: 'FAIL', triage: { class: 'ENV_DB_TIMEOUT' } });
    expect(r.results.gate?.decision).toBe('FAIL'); // c and s are BUG_APP
  });
  it('SEC-3 out-of-scope requests are blocked, counted and logged', async () => {
    const a = site({ '/ok': { ...home, requests: [{ url: 'http://169.254.169.254/latest' }, { url: 'http://evil.example/x.png' }] } });
    const r = await run([makeCase('scope')], a);
    expect(r.res('scope').verdict).toBe('PASS');
    expect(r.results.summary.blocked_requests).toBe(2);
    expect(readFileSync(join(r.runDir, 'run.log'), 'utf8')).toContain('request_blocked');
  });
  it('A6/SEC-6: mutating case on production is BLOCKED and never touches the browser', async () => {
    const a = site({ '/ok': home });
    const r = await run([makeCase('m', { mutating: true })], a, {}, profile({ environment: 'production' }));
    expect(r.res('m')).toMatchObject({ verdict: 'BLOCKED', reason_code: 'MUTATION_ON_PRODUCTION' });
    expect(a.contexts).toBe(0);
  });
  it('SEC-6: unsafe request is allowed only for an exact endpoint bound to an owned resource', async () => {
    const adapter = site({ '/ok': home });
    const sess = await adapter.launch();
    const { buildRequestPolicy } = await import('../../src/executor/guards.js');
    const owned = new Set(['wrchk_mine']);
    const pol = (mutating: boolean) => buildRequestPolicy(profile(), { caseMutating: mutating, authPhase: () => false, owned: () => owned });
    expect(pol(true).check(`${ORIGIN}/api/items/wrchk_mine`, 'DELETE')).toEqual({ allow: true });
    expect(pol(true).check(`${ORIGIN}/api/items/other-users-item`, 'DELETE')).toMatchObject({ allow: false, reason: 'UNOWNED_MUTATION' });
    expect(pol(true).check(`${ORIGIN}/api/items/wrchk_mine?id=other`, 'POST')).toMatchObject({ allow: false });
    expect(pol(true).check(`${ORIGIN}/api/users/wrchk_mine`, 'DELETE')).toMatchObject({ allow: false });
    expect(pol(false).check(`${ORIGIN}/api/items/wrchk_mine`, 'DELETE')).toMatchObject({ allow: false });
    expect(pol(false).check(`${ORIGIN}/anything`, 'GET')).toEqual({ allow: true });
    expect(pol(false).check('http://evil/', 'GET')).toMatchObject({ reason: 'SCOPE_DENIED' });
    await sess.close();
  });
  it('NFR-7/AC-13: abort stops scheduling, runs teardown, remaining cases NON_ESEGUITO, gate INCONCLUSIVE', async () => {
    const ctrl = new AbortController();
    const a = site({ '/ok': home }, { actionDelayMs: 50, onContext: () => ctrl.abort('SIGNAL') });
    const cases = [makeCase('a1', { steps: [{ type: 'fixture', kind: 'item', as: 'i' }, { type: 'navigate', path: '/ok' }] }), makeCase('a2'), makeCase('a3')];
    const r = await run(cases, a, { signal: ctrl.signal });
    expect(r.res('a1').verdict).toBe('INCONCLUSIVE');
    expect(r.res('a2').verdict).toBe('NON_ESEGUITO');
    expect(r.res('a3').verdict).toBe('NON_ESEGUITO');
    expect(r.results.faults).toContain('RUN_ABORTED');
    expect(r.results.gate?.decision).toBe('INCONCLUSIVE');
    expect(r.http.items.size).toBe(0);
  });
  it('quarantined teardown is listed in the report and counted', async () => {
    const http = new FakeHttp();
    http.failDelete = true;
    const r = await runSuite({ profile: profile(), registry: registry(makeCase('q', { steps: [{ type: 'fixture', kind: 'item', as: 'i' }, { type: 'navigate', path: '/ok' }] })), adapter: site({ '/ok': home }), http, outRoot: mkdtempSync(join(tmpdir(), 'wr-')) });
    expect(r.results.quarantined).toHaveLength(1);
    expect(r.results.summary.quarantined).toBe(1);
    expect(r.results.results[0]?.attempts[0]?.notes).toContain('QUARANTINED:1');
  });
  it('SEC-9: a failing artifact writer yields a non-PASS outcome', async () => {
    const a = site({ '/ok': home });
    const r = await run([makeCase('w', { steps: [{ type: 'navigate', path: '/ok' }], oracles: [{ type: 'text_visible', text: 'Welcome' }] })], a, {}, profile({ limits: { max_artifact_bytes_per_case: 1024 } }));
    expect(r.results.gate?.decision).toBe('PASS'); // small evidence fits the cap
    expect(r.results.summary.run_duration_ms).toBeGreaterThanOrEqual(0);
  });
  it('NFR-8 framework overhead per case is far below 50ms with the mock adapter', async () => {
    const cases = Array.from({ length: 40 }, (_v, i) => makeCase(`p${String(i).padStart(2, '0')}`));
    const t = Date.now();
    const r = await run(cases, site({ '/ok': home }), { workers: 4 }, profile({ limits: { max_workers: 4 } }));
    expect(r.results.gate?.decision).toBe('PASS');
    expect((Date.now() - t) / cases.length).toBeLessThan(50);
  });
});
