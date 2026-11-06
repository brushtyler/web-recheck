import type { FixtureSpecT } from '../contracts/index.js';
import type { HttpClient } from '../security/http.js';
import { extractPath, render } from './template.js';
import type { LedgerEntry, Owner } from './ledger.js';

export type RequestSpec = FixtureSpecT['create'];

export function ownerVars(o: Owner): Record<string, string> {
  return { 'owner.run_id': o.run_id, 'owner.shard_id': o.shard_id, 'owner.worker_id': o.worker_id, 'owner.case_id': o.case_id, 'owner.attempt': String(o.attempt) };
}

export function buildRequest(
  baseUrl: string,
  spec: RequestSpec,
  vars: Record<string, string>,
  resolveSecret: (ref: string) => string,
): { url: string; method: string; headers: Record<string, string>; body?: string } {
  const path = render(spec.path, vars, true);
  const headers: Record<string, string> = {};
  if (spec.auth_ref) headers['authorization'] = `Bearer ${resolveSecret(spec.auth_ref)}`;
  let body: string | undefined;
  if (spec.body) {
    body = JSON.stringify(Object.fromEntries(Object.entries(spec.body).map(([k, v]) => [k, typeof v === 'string' ? render(v, vars) : v])));
    headers['content-type'] = 'application/json';
  }
  return { url: new URL(path, baseUrl).toString(), method: spec.method, headers, ...(body !== undefined ? { body } : {}) };
}

export interface TeardownDeps {
  baseUrl: string;
  http: HttpClient;
  resolveSecret: (ref: string) => string;
  timeoutMs: number;
}

/** Delete one resource. 2xx/404/410 = gone. Throws on anything else (caller quarantines). */
export async function executeTeardown(spec: FixtureSpecT, entry: LedgerEntry, d: TeardownDeps): Promise<void> {
  const vars = { ...ownerVars(entry.owner), 'resource.name': entry.name, ...(entry.resource_id ? { 'resource.id': entry.resource_id } : {}) };
  if (!vars['resource.id'] && spec.teardown.path.includes('${resource.id}')) {
    if (!spec.lookup) throw new Error('AMBIGUOUS_CREATE: resource id unknown and no lookup declared');
    const r = await d.http.request({ ...buildRequest(d.baseUrl, spec.lookup, vars, d.resolveSecret), signal: AbortSignal.timeout(d.timeoutMs), timeoutMs: d.timeoutMs });
    if (r.status === 404 || r.status === 410) return;
    if (r.status < 200 || r.status >= 300) throw new Error(`lookup failed with status ${r.status}`);
    const id = extractPath(JSON.parse(r.body), spec.id_path);
    if (!id) return;
    vars['resource.id'] = id;
  }
  const res = await d.http.request({ ...buildRequest(d.baseUrl, spec.teardown, vars, d.resolveSecret), signal: AbortSignal.timeout(d.timeoutMs), timeoutMs: d.timeoutMs });
  if (res.status === 404 || res.status === 410 || (res.status >= 200 && res.status < 300)) return;
  throw new Error(`teardown failed with status ${res.status}`);
}
