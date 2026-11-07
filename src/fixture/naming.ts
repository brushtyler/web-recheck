import { sha256 } from '../compare/hash.js';
import type { Owner } from './ledger.js';

export const SYNTHETIC_PREFIX = 'wrchk_';

/** Full run id + 12 hex chars of the case hash + per-run monotonic seq: unique and recoverable by name. */
export function resourceName(o: Owner, kind: string, seq: number): string {
  return `${SYNTHETIC_PREFIX}${o.run_id.toLowerCase()}_${o.shard_id}_${o.worker_id}_${sha256(o.case_id).slice(0, 12)}_a${o.attempt}_${kind}_${seq}`;
}
