import { z } from 'zod';
import { FrameworkError, type Issue } from '../errors.js';
import { readText } from '../io/files.js';
import { parseYamlSafe, MAX_DOC_BYTES } from '../security/safe-yaml.js';
import { SCHEMA_VERSION } from './common.js';
import { CaseRegistrySchema } from './case-registry.js';
import { GatePolicySchema } from './gate-policy.js';
import { RunManifestSchema } from './run-manifest.js';
import { RunResultsSchema } from './run-results.js';
import { SiteProfileSchema } from './site-profile.js';

export const SCHEMAS = {
  site_profile: SiteProfileSchema,
  case_registry: CaseRegistrySchema,
  run_manifest: RunManifestSchema,
  run_results: RunResultsSchema,
  gate_policy: GatePolicySchema,
} as const;
export type DocKind = keyof typeof SCHEMAS;
export const DOC_KINDS = Object.keys(SCHEMAS) as DocKind[];
type Out<K extends DocKind> = z.infer<(typeof SCHEMAS)[K]>;

const SECRET_KEY = /password|token|secret|cookie|authorization/i;
const REF_RE = /^env:[A-Z][A-Z0-9_]*$/;

export const pointer = (path: readonly PropertyKey[]): string => (path.length === 0 ? '/' : '/' + path.map((p) => String(p).replace(/~/g, '~0').replace(/\//g, '~1')).join('/'));

function findPlaintextSecrets(v: unknown, path: (string | number)[], out: Issue[]): void {
  if (Array.isArray(v)) v.forEach((x, i) => findPlaintextSecrets(x, [...path, i], out));
  else if (v && typeof v === 'object') {
    for (const [k, val] of Object.entries(v)) {
      if (SECRET_KEY.test(k) && typeof val === 'string' && !REF_RE.test(val) && !k.endsWith('_ref')) {
        out.push({ path: pointer([...path, k]), code: 'PLAINTEXT_SECRET', message: 'plaintext secret rejected; use env:NAME' });
      }
      findPlaintextSecrets(val, [...path, k], out);
    }
  }
}

export function validateDocument<K extends DocKind>(kind: K, data: unknown): Out<K> {
  const version = data && typeof data === 'object' ? (data as Record<string, unknown>)['schema_version'] : undefined;
  if (version !== SCHEMA_VERSION) {
    throw new FrameworkError('UNSUPPORTED_SCHEMA_VERSION', `UNSUPPORTED_SCHEMA_VERSION: ${String(version)} (supported: ${SCHEMA_VERSION})`, '/schema_version');
  }
  const issues: Issue[] = [];
  if (kind === 'site_profile' || kind === 'gate_policy') findPlaintextSecrets(data, [], issues);
  const res = SCHEMAS[kind].safeParse(data);
  if (!res.success) {
    for (const i of res.error.issues) issues.push({ path: pointer(i.path), code: i.code, message: i.message });
  }
  if (issues.length > 0) {
    const code = issues.some((i) => i.code === 'PLAINTEXT_SECRET') ? 'PLAINTEXT_SECRET' : 'SCHEMA_VIOLATION';
    throw new FrameworkError(code, `${kind} invalid:\n${issues.map((i) => `  ${i.path}: ${i.message}`).join('\n')}`, issues[0]?.path, issues);
  }
  return (res as unknown as { data: Out<K> }).data;
}

export function parseText(text: string, file: string): unknown {
  if (file.endsWith('.json')) {
    if (Buffer.byteLength(text) > MAX_DOC_BYTES * 20) throw new FrameworkError('SCHEMA_VIOLATION', 'document too large');
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new FrameworkError('SCHEMA_VIOLATION', `invalid JSON: ${(e as Error).message}`);
    }
  }
  return parseYamlSafe(text);
}

export function loadDocument<K extends DocKind>(kind: K, path: string): Out<K> {
  return validateDocument(kind, parseText(readText(path, kind === 'run_results' ? MAX_DOC_BYTES * 20 : MAX_DOC_BYTES), path));
}
