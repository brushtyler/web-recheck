import { z } from 'zod';
import { CaseId, CaseState, Iso, RunId, SchemaVersion, Sha, SiteId } from './common.js';
import { PlanEntry } from './run-results.js';

export const RunManifestSchema = z.strictObject({
  schema_version: SchemaVersion,
  run_id: RunId,
  site_id: SiteId,
  tool_version: z.string(),
  comparison_config_id: z.string(),
  started_at: Iso,
  selection: z.strictObject({ case_ids: z.array(CaseId).optional(), states: z.array(CaseState).optional() }),
  shard_id: z.string().regex(/^[a-z0-9]{1,10}$/),
  workers: z.number().int().min(1).max(8),
  retries: z.number().int().min(0).max(5),
  secrets: z.array(z.string().regex(/^env:[A-Z][A-Z0-9_]*=\*\*\*$/)),
  plan: z.array(PlanEntry),
  plan_digest: Sha,
  registry_digest: Sha,
  policy_digest: Sha,
  profile_digest: Sha,
});
export type RunManifest = z.infer<typeof RunManifestSchema>;
