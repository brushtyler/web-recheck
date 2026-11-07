import { describe, expect, it } from 'vitest';
import { aggregateAttempts, attemptVerdict, shouldRetry } from '../../src/executor/verdict.js';
import { evaluateGate } from '../../src/gate/evaluate.js';
import { digest } from '../../src/compare/hash.js';
import { resolvePolicy } from '../../src/contracts/index.js';
import type { CaseResultT, PlanEntryT } from '../../src/contracts/index.js';

const f = { violations: 0, notEvaluable: 0, actionFailed: false, settled: true };
describe('attempt verdict', () => {
  it.each([
    [{ ...f }, 'PASS'],
    [{ ...f, violations: 1 }, 'FAIL'],
    [{ ...f, blocked: { reason: 'X' } }, 'BLOCKED'],
    [{ ...f, timedOut: 'setup' as const }, 'BLOCKED'],
    [{ ...f, timedOut: 'steps' as const }, 'INCONCLUSIVE'],
    [{ ...f, timedOut: 'steps' as const, violations: 1 }, 'FAIL'],
    [{ ...f, aborted: true }, 'INCONCLUSIVE'],
    [{ ...f, notEvaluable: 1 }, 'INCONCLUSIVE'],
    [{ ...f, settled: false }, 'INCONCLUSIVE'],
    [{ ...f, actionFailed: true }, 'INCONCLUSIVE'],
  ])('%j -> %s', (facts, v) => expect(attemptVerdict(facts).verdict).toBe(v));
  it('retry policy', () => {
    expect(shouldRetry({ verdict: 'FAIL' })).toBe(true);
    expect(shouldRetry({ verdict: 'PASS' })).toBe(false);
    expect(shouldRetry({ verdict: 'BLOCKED', reason_code: 'UNOWNED_MUTATION' })).toBe(false);
  });
});

describe('aggregate over attempts', () => {
  const A = (...vs: string[]) => vs.map((v) => ({ verdict: v as 'PASS' }));
  it('AC-17 fail then pass is flaky INCONCLUSIVE', () => expect(aggregateAttempts(A('FAIL', 'PASS'))).toMatchObject({ verdict: 'INCONCLUSIVE', flaky: true, reason_code: 'FLAKY_PASS_AFTER_RETRY' }));
  it('first pass is PASS', () => expect(aggregateAttempts(A('PASS'))).toMatchObject({ verdict: 'PASS', flaky: false }));
  it('AC-18 all fail -> FAIL reporting the final attempt', () => expect(aggregateAttempts(A('FAIL', 'FAIL', 'FAIL'))).toMatchObject({ verdict: 'FAIL', representative: 2 }));
  it('established FAIL survives later BLOCKED / INCONCLUSIVE', () => {
    expect(aggregateAttempts(A('FAIL', 'BLOCKED'))).toMatchObject({ verdict: 'FAIL', representative: 0 });
    expect(aggregateAttempts(A('FAIL', 'INCONCLUSIVE'))).toMatchObject({ verdict: 'FAIL' });
    expect(aggregateAttempts(A('INCONCLUSIVE', 'BLOCKED')).verdict).toBe('INCONCLUSIVE');
    expect(aggregateAttempts(A('BLOCKED', 'BLOCKED')).verdict).toBe('BLOCKED');
    expect(aggregateAttempts([]).verdict).toBe('NON_ESEGUITO');
  });
});

const entry = (id: string, eligible = true, state: PlanEntryT['state'] = 'EXECUTABLE'): PlanEntryT => ({ case_id: id, case_revision: 1, parameter_set_id: 'ps1:x', content_hash: `sha256:${'0'.repeat(64)}`, state, blocking_eligible: eligible });
const res = (id: string, verdict: CaseResultT['verdict'], extra: Partial<CaseResultT> = {}): CaseResultT => ({ case_id: id, case_revision: 1, parameter_set_id: 'ps1:x', verdict, flaky: false, attempts: [], failed_assertions: [], evidence: [], duration_ms: 1, ...extra });
const tri = (cls: string): CaseResultT['triage'] => ({ class: cls as 'BUG_APP', confidence: 1, rule_id: 'r', rules_version: 'v', items: [{ source: 'oracle', name: 'n', class: cls as 'BUG_APP', confidence: 1, rule_id: 'r' }] });
const gate = (plan: PlanEntryT[], results: CaseResultT[], pol = {}, faults: string[] = []) => evaluateGate({ plan, plan_digest: digest(plan), results, faults }, resolvePolicy({ schema_version: '1', required_cases: [], flaky_as: 'INCONCLUSIVE', non_required_unexecuted: 'INCONCLUSIVE', triage_effect: {}, ...pol }));

describe('gate', () => {
  const p = [entry('a'), entry('b')];
  it('AC-14 precedence FAIL > INCONCLUSIVE > PASS', () => {
    expect(gate(p, [res('a', 'PASS'), res('b', 'PASS')]).decision).toBe('PASS');
    expect(gate(p, [res('a', 'PASS'), res('b', 'INCONCLUSIVE')]).decision).toBe('INCONCLUSIVE');
    expect(gate(p, [res('a', 'FAIL'), res('b', 'INCONCLUSIVE')]).decision).toBe('FAIL');
    expect(gate(p, [res('a', 'FAIL', { triage: tri('BUG_APP') }), res('b', 'PASS')]).decision).toBe('FAIL');
  });
  it('AC-15 required case not executed -> not PASS', () => {
    for (const v of ['BLOCKED', 'NON_ESEGUITO', 'SKIPPED'] as const) {
      expect(gate([entry('a', false, 'DISCOVERED'), entry('b')], [res('a', v), res('b', 'PASS')], { required_cases: ['a'] }).decision).toBe('INCONCLUSIVE');
    }
    expect(gate(p, [res('a', 'FAIL', { triage: tri('BUG_APP') }), res('b', 'BLOCKED')], { required_cases: ['b'] }).decision).toBe('FAIL');
    expect(gate(p, [res('a', 'PASS'), res('b', 'PASS')], { required_cases: ['zz'] }).decision).toBe('INCONCLUSIVE');
  });
  it('AC-16 empty run is INCONCLUSIVE', () => {
    expect(gate([], []).decision).toBe('INCONCLUSIVE');
    expect(gate([entry('a', false, 'DISCOVERED')], [res('a', 'SKIPPED')]).decision).toBe('INCONCLUSIVE');
  });
  it('AC-17 flaky follows flaky_as', () => {
    const r = [res('a', 'INCONCLUSIVE', { flaky: true }), res('b', 'PASS')];
    expect(gate(p, r).decision).toBe('INCONCLUSIVE');
    expect(gate(p, r, { flaky_as: 'FAIL' }).decision).toBe('FAIL');
  });
  it('AC-31 triage_effect maps failures; unknown/untriaged fail closed', () => {
    const one = [entry('a')];
    expect(gate(one, [res('a', 'FAIL', { triage: tri('ENV_DB_TIMEOUT') })]).decision).toBe('INCONCLUSIVE');
    expect(gate(one, [res('a', 'FAIL', { triage: tri('AUTH_FIXTURE') })]).decision).toBe('INCONCLUSIVE');
    expect(gate(one, [res('a', 'FAIL', { triage: tri('BUG_APP') })]).decision).toBe('FAIL');
    expect(gate(one, [res('a', 'FAIL', { triage: tri('UNKNOWN') })]).decision).toBe('FAIL');
    expect(gate(one, [res('a', 'FAIL')]).decision).toBe('FAIL');
    expect(gate(one, [res('a', 'FAIL', { triage: tri('ENV_SERVICE') })], { triage_effect: { ENV_SERVICE: 'FAIL' } }).decision).toBe('FAIL');
  });
  it('mixed evidence: one BUG_APP item outweighs an env item', () => {
    const t = tri('BUG_APP');
    t!.items.push({ source: 'invariant', name: 'x', class: 'ENV_DB_TIMEOUT', confidence: 1, rule_id: 'r' });
    expect(gate([entry('a')], [res('a', 'FAIL', { triage: t })]).decision).toBe('FAIL');
  });
  it('non-required unexecuted can be ignored; ad-hoc cases never gate', () => {
    expect(gate(p, [res('a', 'PASS'), res('b', 'BLOCKED')], { non_required_unexecuted: 'IGNORE' }).decision).toBe('PASS');
    expect(gate([entry('a'), entry('c', false, 'INFERRED')], [res('a', 'PASS'), res('c', 'SKIPPED')]).decision).toBe('PASS');
  });
  it('plan binding: missing, duplicate, unexpected, tampered plan, faults', () => {
    const codes = (d: ReturnType<typeof gate>) => d.reasons.map((r) => r.code);
    expect(codes(gate(p, [res('a', 'PASS'), res('a', 'PASS')]))).toEqual(expect.arrayContaining(['DUPLICATE_RESULT', 'MISSING_RESULT']));
    expect(codes(gate(p, [res('a', 'PASS'), res('b', 'PASS'), res('zz', 'PASS')]))).toContain('UNEXPECTED_RESULT');
    const bad = evaluateGate({ plan: p, plan_digest: digest([entry('x')]), results: [res('a', 'PASS'), res('b', 'PASS')] }, resolvePolicy());
    expect(bad.decision).toBe('INCONCLUSIVE');
    expect(gate(p, [res('a', 'PASS'), res('b', 'PASS')], {}, ['REDACTION']).decision).toBe('INCONCLUSIVE');
  });
  it('SEC-9 gate error fails closed', () => {
    const d = evaluateGate(null as never, resolvePolicy());
    expect(d).toMatchObject({ decision: 'INCONCLUSIVE', reasons: [{ code: 'GATE_ERROR' }] });
  });
});
