import type { AttemptT, VerdictT } from '../contracts/index.js';

export interface AttemptFacts {
  blocked?: { reason: string };
  timedOut?: 'setup' | 'steps';
  aborted?: boolean;
  violations: number;
  notEvaluable: number;
  actionFailed: boolean;
  settled: boolean;
}
export interface VerdictOut { verdict: VerdictT; reason_code?: string }

/** Pure attempt verdict. Established violations are never hidden by a later timeout/abort (threat-model #6). */
export function attemptVerdict(f: AttemptFacts): VerdictOut {
  if (f.blocked) return { verdict: 'BLOCKED', reason_code: f.blocked.reason };
  if (f.timedOut === 'setup') return { verdict: 'BLOCKED', reason_code: 'CASE_TIMEOUT_IN_SETUP' };
  if (f.violations > 0) return { verdict: 'FAIL', reason_code: 'ORACLE_VIOLATED' };
  if (f.timedOut) return { verdict: 'INCONCLUSIVE', reason_code: 'CASE_TIMEOUT' };
  if (f.aborted) return { verdict: 'INCONCLUSIVE', reason_code: 'ABORTED' };
  if (f.actionFailed) return { verdict: 'INCONCLUSIVE', reason_code: 'ACTION_FAILED' };
  if (f.notEvaluable > 0) return { verdict: 'INCONCLUSIVE', reason_code: 'ORACLE_NOT_EVALUABLE' };
  if (!f.settled) return { verdict: 'INCONCLUSIVE', reason_code: 'PAGE_NOT_SETTLED' };
  return { verdict: 'PASS' };
}

export interface Aggregate extends VerdictOut { flaky: boolean; representative: number }

/**
 * Exhaustive aggregation over attempts:
 *  - first attempt PASS            -> PASS
 *  - PASS after an earlier non-PASS -> INCONCLUSIVE + flaky (never silent PASS)
 *  - no PASS: FAIL > INCONCLUSIVE > BLOCKED; an established FAIL survives later infra problems.
 * `representative` = index of the attempt whose failure is reported (latest attempt with the winning verdict).
 */
export function aggregateAttempts(attempts: Pick<AttemptT, 'verdict' | 'reason_code'>[]): Aggregate {
  const first = attempts[0];
  if (!first) return { verdict: 'NON_ESEGUITO', reason_code: 'NOT_ATTEMPTED', flaky: false, representative: -1 };
  if (first.verdict === 'PASS') return { verdict: 'PASS', flaky: false, representative: 0 };
  const passIdx = attempts.findIndex((a) => a.verdict === 'PASS');
  if (passIdx > 0) {
    const firstFail = attempts.findIndex((a) => a.verdict !== 'PASS');
    return { verdict: 'INCONCLUSIVE', reason_code: 'FLAKY_PASS_AFTER_RETRY', flaky: true, representative: firstFail };
  }
  for (const v of ['FAIL', 'INCONCLUSIVE', 'BLOCKED'] as const) {
    const idx = attempts.map((a) => a.verdict).lastIndexOf(v);
    if (idx >= 0) {
      const rc = attempts[idx]?.reason_code;
      return { verdict: v, ...(rc ? { reason_code: rc } : {}), flaky: false, representative: idx };
    }
  }
  return { verdict: first.verdict, flaky: false, representative: 0 };
}

const NO_RETRY = new Set(['MUTATION_ON_PRODUCTION', 'UNOWNED_MUTATION', 'ABORTED']);
export const shouldRetry = (v: VerdictOut): boolean => v.verdict !== 'PASS' && !(v.reason_code && NO_RETRY.has(v.reason_code));
