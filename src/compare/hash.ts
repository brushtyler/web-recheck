import { createHash } from 'node:crypto';

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Canonical JSON v1: sorted keys, no whitespace, NFC strings. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') {
    return typeof v === 'string' ? JSON.stringify(v.normalize('NFC')) : JSON.stringify(v ?? null);
  }
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k.normalize('NFC'))}:${canonicalJson(o[k])}`)
    .join(',')}}`;
}

export const digest = (v: unknown): string => `sha256:${sha256(canonicalJson(v))}`;

export const parameterSetId = (parameters: Record<string, unknown>): string => `ps1:${sha256(canonicalJson(parameters)).slice(0, 32)}`;

/** Fields that change what a result MEANS (observations, verdict and gate semantics). Everything else is excluded. */
export interface ComparisonInputs {
  browser: unknown;
  invariants: unknown;
  limits: { case_timeout_ms: number; run_timeout_ms: number };
  triage_rules: unknown;
  triage_rules_version: string;
  oracles: Record<string, unknown>;
  retries: number;
  policy: { required_cases: string[]; flaky_as: string; non_required_unexecuted: string; triage_effect: unknown };
}

export function comparisonConfigId(inputs: ComparisonInputs): string {
  const picked = {
    v: 'cc1',
    browser: inputs.browser,
    invariants: inputs.invariants,
    timeouts: inputs.limits,
    triage_rules: inputs.triage_rules,
    triage_rules_version: inputs.triage_rules_version,
    oracles: inputs.oracles,
    retries: inputs.retries,
    policy: { ...inputs.policy, required_cases: [...inputs.policy.required_cases].sort() },
  };
  return `cc1:${sha256(canonicalJson(picked))}`;
}
