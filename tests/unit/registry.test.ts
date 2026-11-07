import { describe, expect, it } from 'vitest';
import { validateDocument } from '../../src/contracts/index.js';
import { approve, assertTransition, markNeedsSpec, promote, saveCase, hasValidApproval } from '../../src/registry/lifecycle.js';
import { checkRegistry } from '../../src/registry/registry.js';
import { buildPlan } from '../../src/registry/select.js';
import { makeCase, registry } from '../support/factory.js';

const code = (f: () => unknown): string => { try { f(); } catch (e) { return (e as { code: string }).code; } return 'none'; };

describe('registry lifecycle', () => {
  it('AC-5/A5 INFERRED -> EXECUTABLE is rejected; valid path works', () => {
    expect(code(() => assertTransition('INFERRED', 'EXECUTABLE'))).toBe('ILLEGAL_TRANSITION');
    expect(code(() => promote(makeCase('a', { state: 'INFERRED' })))).toBe('ILLEGAL_TRANSITION');
    const a = approve(makeCase('a', { state: 'INFERRED' }), 'alice', new Date('2026-02-01T00:00:00Z'));
    expect(a.state).toBe('APPROVED');
    expect(promote(a).state).toBe('EXECUTABLE');
    for (const s of ['DISCOVERED', 'INFERRED', 'APPROVED', 'EXECUTABLE'] as const) expect(() => assertTransition(s, 'NEEDS_SPEC')).not.toThrow();
    expect(markNeedsSpec(a).state).toBe('NEEDS_SPEC');
  });
  it('AC-6 approve stores approver, time, revision and content binding', () => {
    const a = approve(makeCase('a', { state: 'DISCOVERED' }), ' alice ', new Date('2026-02-01T00:00:00Z'));
    expect(a.approval).toMatchObject({ approved_by: 'alice', approved_at: '2026-02-01T00:00:00.000Z', approved_revision: 1 });
    expect(() => approve(makeCase('a', { state: 'DISCOVERED' }), '  ')).toThrow();
  });
  it('AC-7 content change bumps revision and requires re-approval (no dead end)', () => {
    const c = makeCase('a');
    const edited = saveCase({ ...c, steps: [{ type: 'navigate', path: '/other' }] });
    expect(edited).toMatchObject({ case_revision: 2, state: 'APPROVED' });
    expect(edited.approval).toBeUndefined();
    expect(code(() => promote(edited))).toBe('ILLEGAL_TRANSITION');
    const re = approve(edited, 'bob');
    expect(promote(re).state).toBe('EXECUTABLE');
    expect(saveCase(c)).toBe(c);
    expect(saveCase({ ...makeCase('d', { state: 'DISCOVERED' }), mutating: true }).state).toBe('DISCOVERED');
  });
  it('AC-8 duplicates fail; hash drift fails closed; forged approvals fail', () => {
    expect(code(() => checkRegistry(registry(makeCase('a'), makeCase('a'))))).toBe('DUPLICATE_CASE_ID');
    expect(code(() => checkRegistry(registry({ ...makeCase('a'), steps: [{ type: 'navigate', path: '/x' }] })))).toBe('REVISION_STALE');
    const c = makeCase('a');
    const forged = { ...c, approval: { ...(c.approval as NonNullable<typeof c.approval>), approved_revision: 7 } };
    expect(code(() => checkRegistry(registry(forged)))).toBe('APPROVAL_INVALID');
    expect(hasValidApproval(forged)).toBe(false);
  });
  it('AC-28 unknown action/oracle types are rejected', () => {
    const c = makeCase('a');
    const bad = (patch: object) => code(() => validateDocument('case_registry', { schema_version: '1', site_id: 'test-site', cases: [{ ...c, ...patch }] }));
    expect(bad({ steps: [{ type: 'eval', script: 'alert(1)' }] })).toBe('SCHEMA_VIOLATION');
    expect(bad({ oracles: [{ type: 'js_expr', expr: '1' }] })).toBe('SCHEMA_VIOLATION');
    expect(bad({ oracles: [] })).toBe('SCHEMA_VIOLATION');
    expect(bad({ steps: [{ type: 'navigate', path: 'http://evil/' }] })).toBe('SCHEMA_VIOLATION');
    expect(bad({ steps: [{ type: 'fill', target: { test_id: 'password' }, value: 'x' }] })).toBe('SCHEMA_VIOLATION');
  });
  it('AC-4 only EXECUTABLE with valid approval is blocking-eligible', () => {
    const plan = buildPlan(registry(makeCase('a'), makeCase('b', { state: 'DISCOVERED' }), makeCase('c', { state: 'INFERRED' }), makeCase('d', { state: 'APPROVED' })));
    expect(plan.map((p) => [p.entry.case_id, p.entry.blocking_eligible])).toEqual([['a', true], ['b', false], ['c', false], ['d', false]]);
    expect(() => buildPlan(registry(makeCase('a')), { case_ids: ['zzz'] })).toThrow();
  });
});
