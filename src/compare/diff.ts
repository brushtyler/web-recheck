import { FrameworkError } from '../errors.js';
import type { RunResults } from '../contracts/index.js';

export interface DiffEntry {
  case_id: string;
  from?: string;
  to?: string;
  status: 'same' | 'changed' | 'added' | 'removed' | 'not_comparable_case';
}

export function diffRuns(a: RunResults, b: RunResults): DiffEntry[] {
  if (a.site_id !== b.site_id) throw new FrameworkError('NOT_COMPARABLE', 'NOT_COMPARABLE: different site_id');
  if (a.comparison_config_id !== b.comparison_config_id) {
    throw new FrameworkError('NOT_COMPARABLE', `NOT_COMPARABLE: comparison_config_id differs (${a.comparison_config_id} vs ${b.comparison_config_id})`);
  }
  const key = (r: RunResults['results'][number]) => `${r.case_id}@${r.case_revision}@${r.parameter_set_id}`;
  const ma = new Map(a.results.map((r) => [key(r), r]));
  const mb = new Map(b.results.map((r) => [key(r), r]));
  const out: DiffEntry[] = [];
  for (const [k, ra] of ma) {
    const rb = mb.get(k);
    if (!rb) out.push({ case_id: ra.case_id, from: ra.verdict, status: [...mb.values()].some((x) => x.case_id === ra.case_id) ? 'not_comparable_case' : 'removed' });
    else out.push({ case_id: ra.case_id, from: ra.verdict, to: rb.verdict, status: ra.verdict === rb.verdict && ra.flaky === rb.flaky ? 'same' : 'changed' });
  }
  for (const [k, rb] of mb) if (!ma.has(k) && ![...ma.values()].some((x) => x.case_id === rb.case_id)) out.push({ case_id: rb.case_id, to: rb.verdict, status: 'added' });
  return out.sort((x, y) => x.case_id.localeCompare(y.case_id));
}
