import { appendLineDurable, exists, readText } from '../io/files.js';

export type LedgerStatus = 'PENDING' | 'CREATED' | 'TORN_DOWN' | 'QUARANTINED' | 'CREATE_REJECTED';
export const OPEN_STATUSES: LedgerStatus[] = ['PENDING', 'CREATED', 'QUARANTINED'];

export interface Owner {
  run_id: string;
  shard_id: string;
  worker_id: string;
  case_id: string;
  attempt: number;
}
export interface LedgerEntry {
  ts: string;
  site_id: string;
  resource_key: string;
  status: LedgerStatus;
  owner: Owner;
  kind: string;
  name: string;
  resource_id?: string;
  reason?: string;
}

/** Append-only JSONL, one fsync'd line per event. The intent (PENDING) is written before any create call. */
export class Ledger {
  private index = new Map<string, LedgerEntry>();
  constructor(readonly path: string) {
    this.reload();
  }

  /** Re-read the file; torn/garbled lines (crash mid-write) are skipped. Latest event per resource wins. */
  reload(): void {
    this.index.clear();
    if (!exists(this.path)) return;
    for (const line of readText(this.path, 256 * 1024 * 1024).split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as LedgerEntry;
        const prev = this.index.get(e.resource_key);
        this.index.set(e.resource_key, { ...prev, ...e });
      } catch {
        /* torn record */
      }
    }
  }

  append(e: Omit<LedgerEntry, 'ts'>): LedgerEntry {
    const full: LedgerEntry = { ts: new Date().toISOString(), ...e };
    appendLineDurable(this.path, JSON.stringify(full));
    this.index.set(e.resource_key, { ...this.index.get(e.resource_key), ...full });
    return full;
  }

  get(key: string): LedgerEntry | undefined {
    return this.index.get(key);
  }
  all(): LedgerEntry[] {
    return [...this.index.values()];
  }
  open(): LedgerEntry[] {
    return this.all().filter((e) => OPEN_STATUSES.includes(e.status));
  }
  quarantined(): LedgerEntry[] {
    return this.all().filter((e) => e.status === 'QUARANTINED');
  }
}
