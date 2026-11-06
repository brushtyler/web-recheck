import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalJson, comparisonConfigId, parameterSetId, type ComparisonInputs } from '../../src/compare/hash.js';
import { diffRuns } from '../../src/compare/diff.js';
import { classifyFailure, triageResult } from '../../src/triage/classifier.js';
import { Redactor } from '../../src/security/redactor.js';
import { ArtifactWriter } from '../../src/io/artifact-writer.js';
import { Logger } from '../../src/log/logger.js';
import { renderHtml, escapeHtml } from '../../src/report/html.js';
import { renderJunit } from '../../src/report/junit.js';
import { computeMetrics } from '../../src/report/metrics.js';
import { isAllowed } from '../../src/security/scope.js';
import { parseSecretRef, resolveSecret } from '../../src/security/secrets.js';
import { redactor } from '../../src/security/redactor.js';
import { resolvePolicy, RunResultsSchema, type RunResults } from '../../src/contracts/index.js';
import { digest } from '../../src/compare/hash.js';
import type { FailureT } from '../../src/contracts/index.js';

const F = (o: Partial<FailureT>): FailureT => ({ source: 'oracle', name: 'text_visible', phase: 'oracles', message: 'm', ...o });

describe('triage', () => {
  it.each([
    [F({ http_status: 504 }), 'ENV_DB_TIMEOUT'],
    [F({ message: 'Database timeout while loading' }), 'ENV_DB_TIMEOUT'],
    [F({ http_status: 503 }), 'ENV_SERVICE'],
    [F({ source: 'setup', phase: 'setup', reason_code: 'AUTH_FIXTURE_FAILED' }), 'AUTH_FIXTURE'],
    [F({ source: 'flaky' }), 'TEST_FLAKY'],
    [F({ source: 'action', reason_code: 'ACTION_FAILED' }), 'DATA_DRIFT'],
    [F({ reason_code: 'ORACLE_NOT_EVALUABLE' }), 'SPEC_GAP'],
    [F({ http_status: 200 }), 'BUG_APP'],
    [F({ source: 'invariant', name: 'invariant:no_same_origin_5xx', http_status: 500 }), 'BUG_APP'],
    [F({ source: 'scope', name: 'zzz' }), 'UNKNOWN'],
  ])('AC-29/30 %#', (f, cls) => expect(classifyFailure(f).class).toBe(cls));
  it('profile rules apply first but cannot override the auth lock', () => {
    const rules = [{ rule_id: 'P1', class: 'ENV_SERVICE' as const, confidence: 1, match: { contains: 'maintenance' } }, { rule_id: 'P2', class: 'BUG_APP' as const, confidence: 1, match: { source: 'setup' as const } }];
    expect(classifyFailure(F({ message: 'down for maintenance' }), rules).rule_id).toBe('P1');
    expect(classifyFailure(F({ source: 'setup', phase: 'setup', reason_code: 'AUTH_FIXTURE_FAILED' }), rules).class).toBe('AUTH_FIXTURE');
  });
  it('unrelated environmental evidence does not explain an oracle failure; primary class is conservative', () => {
    const attempts = [{ failures: [F({}), F({ source: 'invariant', name: 'invariant:no_same_origin_5xx', http_status: 504 })] }] as never;
    const t = triageResult({ verdict: 'FAIL', flaky: false, attempts }, 0);
    expect(t?.items.map((i) => i.class)).toEqual(['BUG_APP', 'ENV_DB_TIMEOUT']);
    expect(t?.class).toBe('BUG_APP');
    expect(triageResult({ verdict: 'PASS', flaky: false, attempts: [] }, 0)).toBeUndefined();
    expect(triageResult({ verdict: 'PASS', flaky: true, attempts: [] }, 0)?.class).toBe('TEST_FLAKY');
  });
});

const inputs = (): ComparisonInputs => ({
  browser: { viewport: { w: 1, h: 1 }, locale: 'en' }, invariants: { a: true }, limits: { case_timeout_ms: 1, run_timeout_ms: 2 },
  triage_rules: [], triage_rules_version: 'v1', oracles: { a: [1] }, retries: 0,
  policy: { required_cases: ['b', 'a'], flaky_as: 'INCONCLUSIVE', non_required_unexecuted: 'INCONCLUSIVE', triage_effect: { BUG_APP: 'FAIL' } },
});
describe('comparability', () => {
  it('AC-32 deterministic; sensitive to every outcome-changing field', () => {
    const base = comparisonConfigId(inputs());
    expect(comparisonConfigId(inputs())).toBe(base);
    expect(comparisonConfigId({ ...inputs(), policy: { ...inputs().policy, required_cases: ['a', 'b'] } })).toBe(base);
    const muts: ((i: ComparisonInputs) => ComparisonInputs)[] = [
      (i) => ({ ...i, browser: { viewport: { w: 2, h: 1 }, locale: 'en' } }), (i) => ({ ...i, invariants: { a: false } }),
      (i) => ({ ...i, limits: { ...i.limits, case_timeout_ms: 9 } }), (i) => ({ ...i, triage_rules: [{ x: 1 }] }),
      (i) => ({ ...i, triage_rules_version: 'v2' }), (i) => ({ ...i, oracles: { a: [2] } }), (i) => ({ ...i, retries: 1 }),
      (i) => ({ ...i, policy: { ...i.policy, flaky_as: 'FAIL' } }), (i) => ({ ...i, policy: { ...i.policy, non_required_unexecuted: 'IGNORE' } }),
      (i) => ({ ...i, policy: { ...i.policy, triage_effect: { BUG_APP: 'INCONCLUSIVE' } } }), (i) => ({ ...i, policy: { ...i.policy, required_cases: ['a'] } }),
    ];
    for (const m of muts) expect(comparisonConfigId(m(inputs()))).not.toBe(base);
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
    expect(parameterSetId({ a: 1, b: 2 })).toBe(parameterSetId({ b: 2, a: 1 }));
  });
  it('AC-33 different configs are NOT_COMPARABLE', () => {
    const mk = (id: string) => ({ site_id: 's', comparison_config_id: id, results: [{ case_id: 'a', case_revision: 1, parameter_set_id: 'p', verdict: 'PASS', flaky: false }] }) as unknown as RunResults;
    expect(() => diffRuns(mk('cc1:a'), mk('cc1:b'))).toThrow(/NOT_COMPARABLE/);
    expect(diffRuns(mk('cc1:a'), mk('cc1:a'))[0]?.status).toBe('same');
  });
});

describe('redaction (SEC-1)', () => {
  const r = new Redactor();
  r.register('Sup3r-Secret-Value');
  it('scrubs patterns and registered secrets in all forms', () => {
    const secret = 'Sup3r-Secret-Value';
    const text = [`Authorization: Bearer abc.def.ghi`, `Cookie: sid=zzz; a=b`, `eyJhbGciOiJI.eyJzdWIiOiIx.sig123`, `{"password":"hunter22","note":"mail a.b@c.com tel +39 333 123 4567"}`,
      `https://x/?api_key=KEY12345&q=1`, secret, encodeURIComponent(secret + '&'), Buffer.from(secret).toString('base64')].join('\n');
    const out = r.redact(text);
    for (const leak of ['abc.def', 'sid=zzz', 'eyJzdWIi', 'hunter22', 'a.b@c.com', '123 4567', 'KEY12345', secret, Buffer.from(secret).toString('base64')]) expect(out).not.toContain(leak);
    expect(r.redact(out)).toBe(out); // idempotent
    expect(r.redact('{"secrets":["env:X=***"],"duration_ms":1234567890,"at":"2026-11-06T10:00:00.000Z"}')).toContain('"duration_ms":1234567890');
  });
  it('discovers runtime opaque tokens and scrubs them everywhere', () => {
    const rr = new Redactor();
    rr.redact('{"session_token":"opaque-RT-1234567890"}');
    expect(rr.redact('plain text with opaque-RT-1234567890 inside')).not.toContain('opaque-RT');
  });
  it('SEC-9 writer fails closed when the redactor throws; nothing is left staged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wr-w-'));
    const bad = { redact: () => { throw new Error('boom'); }, containsSecret: () => false };
    const w = new ArtifactWriter(dir, bad);
    expect(() => w.writeNamed('results.json', 'x')).toThrow(/REDACTION|redaction|failed/i);
    const leaky = { redact: (s: string) => s, containsSecret: () => true };
    expect(() => new ArtifactWriter(dir, leaky).writeNamed('results.json', 'secret')).toThrow();
  });
  it('writer caps evidence per case and in total (SEC-10)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wr-w-'));
    const w = new ArtifactWriter(dir, new Redactor(), { perCaseBytes: 100, totalBytes: 300 });
    expect(w.writeEvidence('events', 'c', 1, { a: 'x'.repeat(50) }).truncated).toBe(false);
    const t = w.writeEvidence('events', 'c', 2, { a: 'x'.repeat(500) });
    expect(t.truncated).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, t.file), 'utf8'))).toMatchObject({ truncated: true, marker: 'ARTIFACT_CAP' });
    expect(() => { for (let i = 0; i < 10; i++) w.writeEvidence('events', `d${i}`, 1, { a: 'y'.repeat(80) }); }).toThrow(/cap/);
  });
  it('logger redacts lines, carries context, and flags redactor failure without leaking', () => {
    const lines: string[] = [];
    redactor.register('LoggedSecret99');
    const l = new Logger('RUN', [(s) => lines.push(s)], 'info').child({ component: 'x', case_id: 'c1', attempt: 2 });
    l.info('evt', { v: 'LoggedSecret99' });
    l.debug('hidden');
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('LoggedSecret99');
    expect(JSON.parse(lines[0] as string)).toMatchObject({ run_id: 'RUN', component: 'x', case_id: 'c1', attempt: 2, event: 'evt' });
    const out: string[] = [];
    const bad = new Logger('R', [(s) => out.push(s)], 'info', {}, { redact: () => { throw new Error('x'); }, containsSecret: () => false });
    bad.info('e', { p: 'raw-secret' });
    expect(bad.hasFault).toBe(true);
    expect(out[0]).not.toContain('raw-secret');
  });
});

describe('scope + secrets + policy', () => {
  it('SEC-3 scope decisions', () => {
    const o = ['http://127.0.0.1:4999'];
    expect(isAllowed('http://127.0.0.1:4999/a', o).allowed).toBe(true);
    for (const u of ['http://evil.com/', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'http://169.254.169.254/', 'http://2852039166/', 'http://[::ffff:169.254.169.254]/', 'nonsense']) expect(isAllowed(u, o).allowed, u).toBe(false);
  });
  it('SEC-2 secret refs', () => {
    expect(() => parseSecretRef('plaintext')).toThrow();
    expect(() => resolveSecret('env:WR_MISSING', {})).toThrow(/not set/);
    expect(resolveSecret('env:WR_X', { WR_X: 'val-123' })).toBe('val-123');
    expect(redactor.redact('has val-123 here')).not.toContain('val-123');
  });
  it('policy defaults fill all 8 triage classes', () => {
    expect(Object.keys(resolvePolicy().triage_effect)).toHaveLength(8);
    expect(resolvePolicy().triage_effect.UNKNOWN).toBe('FAIL');
  });
});

describe('reports', () => {
  const plan = [{ case_id: 'a-b', case_revision: 1, parameter_set_id: 'p', content_hash: `sha256:${'0'.repeat(64)}`, state: 'EXECUTABLE' as const, blocking_eligible: true }];
  const results = [{ case_id: 'a-b', case_revision: 1, parameter_set_id: 'p', verdict: 'FAIL' as const, reason_code: '<script>alert(1)</script>\u0000', flaky: false, attempts: [], failed_assertions: [{ oracle: 'o', expected: '</failure>', actual: '"&' }], evidence: [], duration_ms: 5 }];
  const run: RunResults = {
    schema_version: '1', run_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', site_id: 'x', tool_version: '1', comparison_config_id: 'cc1:x', started_at: '2026-01-01T00:00:00.000Z', finished_at: '2026-01-01T00:00:01.000Z',
    plan, plan_digest: digest(plan), faults: [], results, quarantined: [{ resource_key: 'k', kind: 'item', name: '<img src=x onerror=1>', owner_case_id: 'c', reason: 'r' }],
    summary: computeMetrics(results, 1, 10), gate: { decision: 'FAIL', reasons: [{ code: 'C', message: '<b>x</b>' }] },
  };
  it('AC-34/SEC-8 results validate; HTML and JUnit escape hostile data', () => {
    expect(() => RunResultsSchema.parse(run)).not.toThrow();
    const html = renderHtml(run);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('Content-Security-Policy');
    const xml = renderJunit(run);
    expect(xml).not.toContain('<script>');
    expect(xml).not.toContain('\u0000');
    expect(xml).toContain('<failure');
    expect(xml.match(/<\/failure>/g)).toHaveLength(1);
    expect(escapeHtml(`"'<>&`)).toBe('&quot;&#39;&lt;&gt;&amp;');
  });
  it('NFR-4 metrics', () => {
    const m = computeMetrics([{ ...results[0]!, attempts: [{ blocked_requests: 2 }, { blocked_requests: 1 }] as never, duration_ms: 10 }, { ...results[0]!, case_id: 'b', verdict: 'PASS', attempts: [{ blocked_requests: 0 }] as never, duration_ms: 90 }], 0, 5);
    expect(m).toMatchObject({ retries_used: 1, blocked_requests: 3, case_duration_ms: { p50: 10, p95: 90 }, verdicts: { FAIL: 1, PASS: 1 } });
  });
});
