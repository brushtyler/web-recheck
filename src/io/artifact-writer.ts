import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { FrameworkError } from '../errors.js';
import { move, mkdirp, remove, writeStaged } from './files.js';
import { artifactName, caseHash, resolveInside, type ArtifactKind } from '../security/paths.js';
import type { RedactorLike } from '../security/redactor.js';

export const NAMED_ARTIFACTS = ['manifest.json', 'results.json', 'junit.xml', 'report.html'] as const;
export type NamedArtifact = (typeof NAMED_ARTIFACTS)[number];

export interface WriteResult {
  file: string;
  bytes: number;
  truncated: boolean;
}

/**
 * The single persistence gate for run artifacts: redact -> cap -> stage -> secret re-scan -> rename.
 * File names are generated here; callers never supply paths (SEC-5).
 */
export class ArtifactWriter {
  private perCase = new Map<string, number>();
  private total = 0;

  constructor(
    private readonly root: string,
    private readonly red: RedactorLike,
    private readonly limits: { perCaseBytes: number; totalBytes: number } = { perCaseBytes: 5 * 1024 * 1024, totalBytes: 256 * 1024 * 1024 },
  ) {
    mkdirp(root);
  }

  private commit(rel: string, content: string): WriteResult {
    const target = resolveInside(this.root, rel);
    const staging = join(resolveInside(this.root, '.staging'), randomBytes(8).toString('hex'));
    let redacted: string;
    try {
      redacted = this.red.redact(content);
      writeStaged(staging, redacted);
      if (this.red.containsSecret(redacted) || this.red.redact(redacted) !== redacted) {
        throw new FrameworkError('REDACTION_FAILURE', 'post-write secret scan failed');
      }
      move(staging, target);
    } catch (e) {
      remove(staging);
      if (e instanceof FrameworkError) throw e;
      throw new FrameworkError('REDACTION_FAILURE', 'artifact write failed');
    }
    const bytes = Buffer.byteLength(redacted);
    this.total += bytes;
    return { file: rel, bytes, truncated: false };
  }

  writeNamed(name: NamedArtifact, content: string): WriteResult {
    if (!NAMED_ARTIFACTS.includes(name)) throw new FrameworkError('PATH_ESCAPE', 'unknown artifact name');
    return this.commit(name, content);
  }

  /** Per-case evidence file with size caps; over-cap data is replaced with a truncation marker. */
  writeEvidence(kind: ArtifactKind, caseId: string, attempt: number, data: unknown): WriteResult {
    let content = JSON.stringify(data);
    const key = caseHash(caseId);
    const used = this.perCase.get(key) ?? 0;
    let truncated = false;
    if (used + Buffer.byteLength(content) > this.limits.perCaseBytes) {
      content = JSON.stringify({ truncated: true, marker: 'ARTIFACT_CAP', original_bytes: Buffer.byteLength(content) });
      truncated = true;
    }
    if (this.total + Buffer.byteLength(content) > this.limits.totalBytes) {
      throw new FrameworkError('CAP_EXCEEDED', 'total artifact size cap exceeded');
    }
    const res = this.commit(join('evidence', artifactName(kind, caseId, attempt)), content);
    this.perCase.set(key, used + res.bytes);
    return { ...res, truncated };
  }
}
