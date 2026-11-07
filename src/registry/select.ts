import { FrameworkError } from '../errors.js';
import { digest, parameterSetId } from '../compare/hash.js';
import type { CaseRegistry, CaseT, PlanEntryT } from '../contracts/index.js';
import { computeContentHash, hasValidApproval } from './lifecycle.js';

export interface Selection {
  case_ids?: string[];
}

export interface PlannedCase {
  entry: PlanEntryT;
  case: CaseT;
}

/** Resolve the execution plan. Only EXECUTABLE cases with approval bound to the current content are blocking-eligible. */
export function buildPlan(reg: CaseRegistry, sel: Selection = {}): PlannedCase[] {
  const wanted = sel.case_ids ? new Set(sel.case_ids) : undefined;
  if (wanted) for (const id of wanted) if (!reg.cases.some((c) => c.case_id === id)) throw new FrameworkError('USAGE_ERROR', `selected case ${id} not in registry`);
  return reg.cases
    .filter((c) => !wanted || wanted.has(c.case_id))
    .map((c) => ({
      case: c,
      entry: {
        case_id: c.case_id,
        case_revision: c.case_revision,
        parameter_set_id: parameterSetId(c.parameters),
        content_hash: computeContentHash(c),
        state: c.state,
        blocking_eligible: c.state === 'EXECUTABLE' && hasValidApproval(c),
        ...(c.approval ? { approved_by: c.approval.approved_by } : {}),
      },
    }))
    .sort((a, b) => a.entry.case_id.localeCompare(b.entry.case_id));
}

export const planDigest = (plan: PlanEntryT[]): string => digest(plan);
