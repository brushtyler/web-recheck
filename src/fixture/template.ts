import { FrameworkError } from '../errors.js';

/** `${a.b}` substitution from a flat vars map; unknown variables are errors. Path values are URL-encoded by the caller. */
export function render(tpl: string, vars: Record<string, string>, encode = false): string {
  return tpl.replace(/\$\{([A-Za-z0-9_.]+)\}/g, (_m, k: string) => {
    const v = vars[k];
    if (v === undefined) throw new FrameworkError('FIXTURE_FAILED', `unknown template variable \${${k}}`);
    return encode ? encodeURIComponent(v) : v;
  });
}

export function extractPath(obj: unknown, path: string): string | undefined {
  let cur: unknown = obj;
  for (const p of path.split('.')) {
    if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) cur = (cur as Record<string, unknown>)[p];
    else return undefined;
  }
  return typeof cur === 'string' || typeof cur === 'number' ? String(cur) : undefined;
}
