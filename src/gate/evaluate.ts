import { digest } from '../compare/hash.js';
import type { GateDecisionT, PlanEntryT, RunResults } from '../contracts/index.js';
import type { ResolvedPolicy } from '../contracts/gate-policy.js';

type Dec = GateDecisionT['decision'];
const RANK: Record<Dec, number> = { PASS: 0, INCONCLUSIVE: 1, FAIL: 2 };

export interface GateInput {
  plan: PlanEntryT[];
  plan_digest: string;
  results: RunResults['results'];
  faults?: string[];
}

/** Pure gate. Precedence FAIL > INCONCLUSIVE > PASS; any internal error => INCONCLUSIVE (fail closed). */
export function evaluateGate(input: GateInput, policy: ResolvedPolicy): GateDecisionT {
  try {
    return evaluate(input, policy);
  } catch (e) {
    return { decision: 'INCONCLUSIVE', reasons: [{ code: 'GATE_ERROR', message: `gate evaluation failed: ${(e as Error).message}` }] };
  }
}

function evaluate(input: GateInput, policy: ResolvedPolicy): GateDecisionT {
  const reasons: GateDecisionT['reasons'] = [];
  let decision: Dec = 'PASS';
  const bump = (d: Dec) => {
    if (RANK[d] > RANK[decision]) decision = d;
  };
  const add = (d: Dec, r: GateDecisionT['reasons'][number]) => {
    bump(d);
    reasons.push({ ...r, effect: r.effect ?? d });
  };

  if (digest(input.plan) !== input.plan_digest) add('INCONCLUSIVE', { code: 'PLAN_TAMPERED', message: 'plan does not match plan_digest' });
  for (const f of input.faults ?? []) add('INCONCLUSIVE', { code: f, message: `run fault: ${f}` });

  const ident = (r: { case_id: string; case_revision: number; parameter_set_id: string }) => `${r.case_id}|${r.case_revision}|${r.parameter_set_id}`;
  const byId = new Map<string, RunResults['results']>();
  for (const r of input.results) byId.set(ident(r), [...(byId.get(ident(r)) ?? []), r]);
  const planIds = new Set(input.plan.map(ident));
  for (const [k, list] of byId) {
    if (!planIds.has(k)) add('INCONCLUSIVE', { code: 'UNEXPECTED_RESULT', message: `result not in plan: ${k}`, case_id: list[0]?.case_id ?? k });
    if (list.length > 1) add('INCONCLUSIVE', { code: 'DUPLICATE_RESULT', message: `multiple results for ${k}`, case_id: list[0]?.case_id ?? k });
  }
  for (const id of policy.required_cases) {
    if (!input.plan.some((p) => p.case_id === id)) add('INCONCLUSIVE', { code: 'REQUIRED_NOT_PLANNED', message: `required case ${id} is not in the plan`, case_id: id });
  }

  let executed = 0;
  for (const p of input.plan) {
    const list = byId.get(ident(p)) ?? [];
    const r = list.length === 1 ? list[0] : undefined;
    const required = policy.required_cases.includes(p.case_id);
    if (!r) {
      add('INCONCLUSIVE', { code: 'MISSING_RESULT', message: `no result for planned case ${p.case_id}`, case_id: p.case_id });
      continue;
    }
    if (r.verdict === 'PASS' || r.verdict === 'FAIL' || r.verdict === 'INCONCLUSIVE') executed++;
    if (!p.blocking_eligible) {
      if (required) add('INCONCLUSIVE', { code: 'REQUIRED_NOT_EXECUTABLE', message: `required case ${p.case_id} is not blocking-eligible (${p.state})`, case_id: p.case_id, verdict: r.verdict });
      continue; // ad-hoc discoveries never gate a release (SEC-7)
    }
    const base = { case_id: p.case_id, verdict: r.verdict };
    if (r.flaky) {
      add(policy.flaky_as, { code: 'FLAKY', message: 'passed only after retry', ...base, ...(r.triage ? { triage_class: r.triage.class } : {}), effect: policy.flaky_as });
    } else if (r.verdict === 'FAIL') {
      const items = r.triage?.items ?? [];
      const effects = items.map((i) => ({ cls: i.class, eff: policy.triage_effect[i.class] }));
      const failing = effects.find((e) => e.eff === 'FAIL');
      if (failing || effects.length === 0) add('FAIL', { code: 'CASE_FAILED', message: `case failed${failing ? ` (${failing.cls})` : ' (untriaged)'}`, ...base, ...(failing ? { triage_class: failing.cls } : {}), effect: 'FAIL' });
      else add('INCONCLUSIVE', { code: 'FAIL_DOWNGRADED', message: `failure attributed to ${effects.map((e) => e.cls).join(',')}`, ...base, ...(r.triage ? { triage_class: r.triage.class } : {}), effect: 'INCONCLUSIVE' });
    } else if (r.verdict === 'INCONCLUSIVE') {
      add('INCONCLUSIVE', { code: 'CASE_INCONCLUSIVE', message: r.reason_code ?? 'inconclusive', ...base });
    } else if (r.verdict === 'BLOCKED' || r.verdict === 'NON_ESEGUITO' || r.verdict === 'SKIPPED') {
      if (required || policy.non_required_unexecuted === 'INCONCLUSIVE') add('INCONCLUSIVE', { code: `CASE_${r.verdict}`, message: r.reason_code ?? r.verdict, ...base });
    }
  }
  if (executed === 0) add('INCONCLUSIVE', { code: 'EMPTY_RUN', message: 'no case was executed' });
  return { decision, reasons };
}
