import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';
import { FrameworkError } from '../errors.js';
import { isInside, realpathDeepestExisting } from '../io/files.js';

/** Resolve `p` against `root`; reject absolute paths, `..` escapes and symlink escapes (SEC-5). */
export function resolveInside(root: string, p: string): string {
  if (isAbsolute(p) || p.includes('\0')) throw new FrameworkError('PATH_ESCAPE', `absolute or invalid path rejected: ${p}`, p);
  const absRoot = resolve(root);
  const resolved = resolve(absRoot, p);
  const rel = relative(absRoot, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new FrameworkError('PATH_ESCAPE', `path escapes root: ${p}`, p);
  const realRoot = realpathDeepestExisting(absRoot);
  const realResolved = realpathDeepestExisting(resolved);
  if (!isInside(realRoot, realResolved)) throw new FrameworkError('PATH_ESCAPE', `symlink escapes root: ${p}`, p);
  return resolved;
}

export const ARTIFACT_KINDS = ['events', 'assertions', 'log'] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/** Tool-generated artifact file name: case data never supplies file names (SEC-5). */
export function artifactName(kind: ArtifactKind, caseId: string, attempt: number, ext = 'json'): string {
  const h = createHash('sha256').update(caseId).digest('hex').slice(0, 16);
  return `${kind}-${h}-${attempt}.${ext}`;
}

export function caseHash(caseId: string): string {
  return createHash('sha256').update(caseId).digest('hex').slice(0, 16);
}
