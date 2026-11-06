import { z } from 'zod';
import { CaseId, GateEffect, SchemaVersion, TRIAGE_CLASSES, TriageClass, type TriageClassT } from './common.js';

export const DEFAULT_TRIAGE_EFFECT: Record<TriageClassT, 'FAIL' | 'INCONCLUSIVE'> = {
  BUG_APP: 'FAIL',
  ENV_DB_TIMEOUT: 'INCONCLUSIVE',
  ENV_SERVICE: 'INCONCLUSIVE',
  AUTH_FIXTURE: 'INCONCLUSIVE',
  TEST_FLAKY: 'INCONCLUSIVE',
  SPEC_GAP: 'INCONCLUSIVE',
  DATA_DRIFT: 'INCONCLUSIVE',
  UNKNOWN: 'FAIL',
};

export const GatePolicySchema = z.strictObject({
  schema_version: SchemaVersion,
  required_cases: z.array(CaseId).default([]),
  flaky_as: GateEffect.default('INCONCLUSIVE'),
  non_required_unexecuted: z.enum(['INCONCLUSIVE', 'IGNORE']).default('INCONCLUSIVE'),
  triage_effect: z.partialRecord(TriageClass, GateEffect).default({}),
});

export type GatePolicy = z.infer<typeof GatePolicySchema>;
export interface ResolvedPolicy {
  required_cases: string[];
  flaky_as: 'FAIL' | 'INCONCLUSIVE';
  non_required_unexecuted: 'INCONCLUSIVE' | 'IGNORE';
  triage_effect: Record<TriageClassT, 'FAIL' | 'INCONCLUSIVE'>;
}

export function resolvePolicy(p?: GatePolicy): ResolvedPolicy {
  const effect = { ...DEFAULT_TRIAGE_EFFECT };
  for (const c of TRIAGE_CLASSES) effect[c] = p?.triage_effect[c] ?? effect[c];
  return {
    required_cases: [...(p?.required_cases ?? [])].sort(),
    flaky_as: p?.flaky_as ?? 'INCONCLUSIVE',
    non_required_unexecuted: p?.non_required_unexecuted ?? 'INCONCLUSIVE',
    triage_effect: effect,
  };
}
