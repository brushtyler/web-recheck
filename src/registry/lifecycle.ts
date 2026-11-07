import { FrameworkError } from '../errors.js';
import { digest } from '../compare/hash.js';
import type { CaseStateT } from '../contracts/common.js';
import type { CaseT } from '../contracts/case-registry.js';

export const computeContentHash = (c: Pick<CaseT, 'steps' | 'oracles' | 'parameters' | 'mutating'>): string =>
  digest({ steps: c.steps, oracles: c.oracles, parameters: c.parameters, mutating: c.mutating });

const ALLOWED: Record<CaseStateT, CaseStateT[]> = {
  DISCOVERED: ['APPROVED', 'NEEDS_SPEC'],
  INFERRED: ['APPROVED', 'NEEDS_SPEC'],
  APPROVED: ['EXECUTABLE', 'NEEDS_SPEC'],
  EXECUTABLE: ['NEEDS_SPEC'],
  NEEDS_SPEC: [],
};

export function assertTransition(from: CaseStateT, to: CaseStateT): void {
  if (!ALLOWED[from].includes(to)) throw new FrameworkError('ILLEGAL_TRANSITION', `ILLEGAL_TRANSITION: ${from} -> ${to}`);
}

/** Approval is valid only for the exact revision AND content it was recorded against (SEC-7). */
export function hasValidApproval(c: CaseT): boolean {
  const a = c.approval;
  return !!a && a.approved_by.trim() !== '' && a.approved_revision === c.case_revision && a.approved_content_hash === computeContentHash(c);
}

export function approve(c: CaseT, by: string, now = new Date()): CaseT {
  if (!by || by.trim() === '') throw new FrameworkError('USAGE_ERROR', 'approved_by must not be empty');
  if (c.content_hash !== computeContentHash(c)) throw new FrameworkError('REVISION_STALE', `case ${c.case_id} content changed; run registry save first`);
  // A re-approval of an edited (APPROVED, approval cleared) case is the only APPROVED -> APPROVED stamp.
  if (!(c.state === 'APPROVED' && !hasValidApproval(c))) assertTransition(c.state, 'APPROVED');
  return {
    ...c,
    state: 'APPROVED',
    approval: { approved_by: by.trim(), approved_at: now.toISOString(), approved_revision: c.case_revision, approved_content_hash: c.content_hash },
  };
}

export function promote(c: CaseT): CaseT {
  assertTransition(c.state, 'EXECUTABLE');
  if (!hasValidApproval(c)) throw new FrameworkError('ILLEGAL_TRANSITION', `ILLEGAL_TRANSITION: ${c.case_id} has no valid approval for revision ${c.case_revision}`);
  return { ...c, state: 'EXECUTABLE' };
}

export function markNeedsSpec(c: CaseT): CaseT {
  if (c.state !== 'NEEDS_SPEC') assertTransition(c.state, 'NEEDS_SPEC');
  const { approval: _a, ...rest } = c;
  return { ...rest, state: 'NEEDS_SPEC' };
}

/** AC-7: content change bumps the revision; approved/executable cases fall back to APPROVED awaiting re-approval. */
export function saveCase(c: CaseT): CaseT {
  const hash = computeContentHash(c);
  if (hash === c.content_hash) return c;
  const { approval: _a, ...rest } = c;
  const falls = c.state === 'APPROVED' || c.state === 'EXECUTABLE';
  return { ...rest, content_hash: hash, case_revision: c.case_revision + 1, state: falls ? 'APPROVED' : c.state };
}
