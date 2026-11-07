import { z } from 'zod';
import { CaseId, CaseState, GateDecisionValue, Iso, RunId, SchemaVersion, Sha, SiteId, TriageClass, Verdict } from './common.js';

export const PlanEntry = z.strictObject({
  case_id: CaseId,
  case_revision: z.number().int().min(1),
  parameter_set_id: z.string(),
  content_hash: Sha,
  state: CaseState,
  blocking_eligible: z.boolean(),
  approved_by: z.string().optional(),
});

export const Failure = z.strictObject({
  source: z.enum(['oracle', 'invariant', 'setup', 'timeout', 'action', 'scope', 'flaky', 'abort']),
  name: z.string(),
  phase: z.enum(['setup', 'steps', 'oracles', 'teardown']),
  reason_code: z.string().optional(),
  http_status: z.number().int().optional(),
  message: z.string(),
});

const FailedAssertion = z.strictObject({ oracle: z.string(), expected: z.unknown(), actual: z.unknown() });
const EvidenceRef = z.strictObject({ kind: z.string(), file: z.string(), bytes: z.number().int(), truncated: z.boolean() });

export const Attempt = z.strictObject({
  attempt: z.number().int().min(1),
  verdict: Verdict,
  reason_code: z.string().optional(),
  fixture_ids: z.array(z.string()),
  failures: z.array(Failure),
  failed_assertions: z.array(FailedAssertion),
  evidence: z.array(EvidenceRef),
  blocked_requests: z.number().int().min(0),
  notes: z.array(z.string()),
  duration_ms: z.number().min(0),
});

const TriageItem = z.strictObject({ source: z.string(), name: z.string(), class: TriageClass, confidence: z.number(), rule_id: z.string() });
export const Triage = z.strictObject({
  class: TriageClass,
  confidence: z.number().min(0).max(1),
  rule_id: z.string(),
  rules_version: z.string(),
  items: z.array(TriageItem),
});

export const CaseResult = z.strictObject({
  case_id: CaseId,
  case_revision: z.number().int().min(1),
  parameter_set_id: z.string(),
  verdict: Verdict,
  reason_code: z.string().optional(),
  flaky: z.boolean(),
  attempts: z.array(Attempt),
  triage: Triage.optional(),
  failed_assertions: z.array(FailedAssertion),
  evidence: z.array(EvidenceRef),
  duration_ms: z.number().min(0),
});

const Percentiles = z.strictObject({ p50: z.number(), p95: z.number() });
export const Metrics = z.strictObject({
  verdicts: z.record(z.string(), z.number().int()),
  triage: z.record(z.string(), z.number().int()),
  flaky: z.number().int(),
  quarantined: z.number().int(),
  retries_used: z.number().int(),
  blocked_requests: z.number().int(),
  run_duration_ms: z.number(),
  case_duration_ms: Percentiles,
});

export const QuarantineEntry = z.strictObject({
  resource_key: z.string(),
  kind: z.string(),
  name: z.string(),
  owner_case_id: z.string(),
  reason: z.string(),
});

export const GateReason = z.strictObject({
  code: z.string(),
  message: z.string(),
  case_id: z.string().optional(),
  verdict: Verdict.optional(),
  triage_class: TriageClass.optional(),
  effect: z.string().optional(),
});
export const GateDecision = z.strictObject({ decision: GateDecisionValue, reasons: z.array(GateReason) });

export const RunResultsSchema = z.strictObject({
  schema_version: SchemaVersion,
  run_id: RunId,
  site_id: SiteId,
  tool_version: z.string(),
  comparison_config_id: z.string(),
  started_at: Iso,
  finished_at: Iso,
  plan: z.array(PlanEntry),
  plan_digest: Sha,
  faults: z.array(z.string()),
  gate: GateDecision.optional(),
  results: z.array(CaseResult),
  quarantined: z.array(QuarantineEntry),
  summary: Metrics,
});

export type RunResults = z.infer<typeof RunResultsSchema>;
export type CaseResultT = z.infer<typeof CaseResult>;
export type AttemptT = z.infer<typeof Attempt>;
export type FailureT = z.infer<typeof Failure>;
export type PlanEntryT = z.infer<typeof PlanEntry>;
export type GateDecisionT = z.infer<typeof GateDecision>;
export type MetricsT = z.infer<typeof Metrics>;
export type QuarantineEntryT = z.infer<typeof QuarantineEntry>;
export type TriageT = z.infer<typeof Triage>;
