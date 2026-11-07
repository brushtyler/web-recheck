import { join } from 'node:path';
import { errMessage } from '../errors.js';
import type { SiteProfile } from '../contracts/index.js';
import { listDirs, exists } from '../io/files.js';
import type { Logger } from '../log/logger.js';
import type { HttpClient } from '../security/http.js';
import { Ledger } from './ledger.js';
import { acquireReapLock, defaultLiveness, isRunActive, type Liveness } from './runlock.js';
import { executeTeardown } from './teardown.js';

export interface ReapOpts {
  runsDir: string;
  profile: SiteProfile;
  http: HttpClient;
  resolveSecret: (ref: string) => string;
  logger: Logger;
  dryRun?: boolean;
  liveness?: Liveness;
}
export interface ReapReport {
  removed: string[];
  failed: string[];
  skipped_active: string[];
}

/** Removes only resources of runs that are provably inactive (see isRunActive). Locally serialised. */
export async function reap(o: ReapOpts): Promise<ReapReport> {
  const live = o.liveness ?? defaultLiveness();
  const report: ReapReport = { removed: [], failed: [], skipped_active: [] };
  const release = acquireReapLock(o.runsDir, live);
  if (!release) {
    o.logger.warn('reap_locked', {});
    return report;
  }
  try {
    for (const runId of listDirs(o.runsDir)) {
      const dir = join(o.runsDir, runId);
      const ledgerPath = join(dir, 'ledger.jsonl');
      if (!exists(ledgerPath)) continue;
      if (isRunActive(dir, ledgerPath, { ...live, now: Date.now() })) {
        report.skipped_active.push(runId);
        continue;
      }
      const ledger = new Ledger(ledgerPath);
      for (const e of ledger.open()) {
        if (e.site_id !== o.profile.site_id) continue;
        // Re-check liveness immediately before each deletion (same lock holds competing reapers out).
        if (isRunActive(dir, ledgerPath, { ...live, now: Date.now() })) break;
        const spec = o.profile.fixtures[e.kind];
        if (!spec) {
          report.failed.push(e.resource_key);
          continue;
        }
        if (o.dryRun) {
          o.logger.info('fixture_reap_dry_run', { resource_key: e.resource_key, owner: e.owner });
          continue;
        }
        try {
          await executeTeardown(spec, e, { baseUrl: o.profile.base_url, http: o.http, resolveSecret: o.resolveSecret, timeoutMs: o.profile.limits.teardown_timeout_ms });
          ledger.append({ site_id: e.site_id, resource_key: e.resource_key, status: 'TORN_DOWN', owner: e.owner, kind: e.kind, name: e.name });
          o.logger.info('fixture_reaped', { resource_key: e.resource_key, kind: e.kind, owner: e.owner });
          report.removed.push(e.resource_key);
        } catch (err) {
          o.logger.warn('fixture_reap_failed', { resource_key: e.resource_key, reason: errMessage(err).slice(0, 200) });
          report.failed.push(e.resource_key);
        }
      }
    }
  } finally {
    release();
  }
  return report;
}
