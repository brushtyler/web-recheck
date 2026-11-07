import { TRIAGE_CLASSES, VERDICTS, type CaseResultT, type MetricsT } from '../contracts/index.js';

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] as number;
}

export function computeMetrics(results: CaseResultT[], quarantined: number, runDurationMs: number): MetricsT {
  const verdicts = Object.fromEntries(VERDICTS.map((v) => [v, 0]));
  const triage = Object.fromEntries(TRIAGE_CLASSES.map((c) => [c, 0]));
  let flaky = 0, retries = 0, blocked = 0;
  for (const r of results) {
    verdicts[r.verdict] = (verdicts[r.verdict] ?? 0) + 1;
    if (r.triage) triage[r.triage.class] = (triage[r.triage.class] ?? 0) + 1;
    if (r.flaky) flaky++;
    retries += Math.max(0, r.attempts.length - 1);
    blocked += r.attempts.reduce((s, a) => s + a.blocked_requests, 0);
  }
  const durs = results.filter((r) => r.attempts.length > 0).map((r) => r.duration_ms).sort((a, b) => a - b);
  return { verdicts, triage, flaky, quarantined, retries_used: retries, blocked_requests: blocked, run_duration_ms: runDurationMs, case_duration_ms: { p50: percentile(durs, 50), p95: percentile(durs, 95) } };
}
