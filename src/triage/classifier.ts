import type { CaseResultT, FailureT, TriageClassT, TriageRuleT, TriageT } from '../contracts/index.js';

export const RULES_VERSION = 'triage-rules-1';

const R = (rule_id: string, cls: TriageClassT, confidence: number, match: TriageRuleT['match']): TriageRuleT => ({ rule_id, class: cls, confidence, match });

/** Locked first: profile rules can never reclassify an authentication-fixture failure. */
export const LOCKED_RULES: TriageRuleT[] = [R('LOCK-AUTH', 'AUTH_FIXTURE', 0.95, { reason_code: 'AUTH_FIXTURE_FAILED' })];

export const DEFAULT_RULES: TriageRuleT[] = [
  R('D-FLAKY', 'TEST_FLAKY', 0.8, { source: 'flaky' }),
  R('D-DBTO-504', 'ENV_DB_TIMEOUT', 0.9, { http_status: [504] }),
  R('D-DBTO-TXT1', 'ENV_DB_TIMEOUT', 0.8, { contains: 'database timeout' }),
  R('D-DBTO-TXT2', 'ENV_DB_TIMEOUT', 0.8, { contains: 'db timeout' }),
  R('D-DBTO-TXT3', 'ENV_DB_TIMEOUT', 0.7, { contains: 'gateway timeout' }),
  R('D-SVC-5xx', 'ENV_SERVICE', 0.85, { http_status: [502, 503] }),
  R('D-SVC-REFUSED', 'ENV_SERVICE', 0.8, { contains: 'econnrefused' }),
  R('D-SVC-REFUSED2', 'ENV_SERVICE', 0.8, { contains: 'connection refused' }),
  R('D-FIXTURE', 'ENV_SERVICE', 0.5, { reason_code: 'FIXTURE_FAILED' }),
  R('D-TIMEOUT', 'ENV_SERVICE', 0.3, { source: 'timeout' }),
  R('D-SPEC-GAP', 'SPEC_GAP', 0.7, { reason_code: 'ORACLE_NOT_EVALUABLE' }),
  R('D-DRIFT', 'DATA_DRIFT', 0.4, { source: 'action' }),
  R('D-BUG-5XX', 'BUG_APP', 0.7, { source: 'invariant', name: 'invariant:no_same_origin_5xx' }),
  R('D-BUG-CONSOLE', 'BUG_APP', 0.6, { source: 'invariant', name: 'invariant:no_console_errors' }),
  R('D-BUG-ORACLE', 'BUG_APP', 0.8, { source: 'oracle' }),
];

const PRIORITY: TriageClassT[] = ['BUG_APP', 'UNKNOWN', 'SPEC_GAP', 'DATA_DRIFT', 'TEST_FLAKY', 'AUTH_FIXTURE', 'ENV_SERVICE', 'ENV_DB_TIMEOUT'];

function matches(r: TriageRuleT, f: FailureT): boolean {
  const m = r.match;
  return (
    (m.phase === undefined || m.phase === f.phase) &&
    (m.source === undefined || m.source === f.source) &&
    (m.name === undefined || m.name === f.name) &&
    (m.reason_code === undefined || m.reason_code === f.reason_code) &&
    (m.http_status === undefined || (f.http_status !== undefined && m.http_status.includes(f.http_status))) &&
    (m.contains === undefined || f.message.toLowerCase().includes(m.contains.toLowerCase()))
  );
}

export function classifyFailure(f: FailureT, profileRules: TriageRuleT[] = []): { class: TriageClassT; confidence: number; rule_id: string } {
  for (const r of [...LOCKED_RULES, ...profileRules, ...DEFAULT_RULES]) if (matches(r, f)) return { class: r.class, confidence: r.confidence, rule_id: r.rule_id };
  return { class: 'UNKNOWN', confidence: 0, rule_id: 'NO-MATCH' };
}

/** Per-failure classification (each failure is explained only by its own evidence); the primary class is the most conservative. */
export function triageResult(r: Pick<CaseResultT, 'verdict' | 'flaky' | 'attempts'>, representative: number, profileRules: TriageRuleT[] = []): TriageT | undefined {
  if (r.verdict !== 'FAIL' && r.verdict !== 'BLOCKED' && !r.flaky) return undefined;
  let failures = r.attempts[representative]?.failures ?? [];
  if (r.flaky) failures = [{ source: 'flaky', name: 'flaky', phase: 'steps', reason_code: 'FLAKY_PASS_AFTER_RETRY', message: 'passed only after retry' }];
  if (failures.length === 0) failures = [{ source: 'setup', name: 'unspecified', phase: 'setup', message: r.attempts[representative]?.reason_code ?? 'unspecified' }];
  const items = failures.map((f) => ({ source: f.source, name: f.name, ...classifyFailure(f, profileRules) }));
  const primary = [...items].sort((a, b) => PRIORITY.indexOf(a.class) - PRIORITY.indexOf(b.class))[0];
  if (!primary) return undefined;
  return { class: primary.class, confidence: primary.confidence, rule_id: primary.rule_id, rules_version: RULES_VERSION, items };
}
