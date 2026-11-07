// The ONLY module (with artifact-writer) allowed to touch the file system (lint-enforced).
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, resolve, sep, basename } from 'node:path';

export function readText(path: string, maxBytes = 10 * 1024 * 1024): string {
  const st = statSync(path);
  if (st.size > maxBytes) throw new Error(`file too large: ${basename(path)} (${st.size} > ${maxBytes})`);
  return readFileSync(path, 'utf8');
}

export function exists(path: string): boolean {
  return existsSync(path);
}

export function mkdirp(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function writeAtomic(path: string, data: string): void {
  mkdirp(dirname(path));
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, data, 'utf8');
  renameSync(tmp, path);
}

/** Durable single-line append (O_APPEND + fsync). */
export function appendLineDurable(path: string, line: string): void {
  mkdirp(dirname(path));
  const fd = openSync(path, 'a');
  try {
    writeSync(fd, line + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function appendLine(path: string, line: string): void {
  mkdirp(dirname(path));
  appendFileSync(path, line + '\n', 'utf8');
}

export function listDirs(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

export function mtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

export function remove(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

export function move(from: string, to: string): void {
  mkdirp(dirname(to));
  renameSync(from, to);
}

export function writeStaged(path: string, data: string): void {
  mkdirp(dirname(path));
  writeFileSync(path, data, 'utf8');
}

/** Atomically create a file; returns false when it already exists. */
export function tryCreateExclusive(path: string, content: string): boolean {
  mkdirp(dirname(path));
  try {
    writeFileSync(path, content, { flag: 'wx' });
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  }
}

/** realpath of the deepest existing ancestor (used for symlink-escape detection). */
export function realpathDeepestExisting(path: string): string {
  let cur = resolve(path);
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return realpathSync(cur);
}

export function isInside(root: string, candidate: string): boolean {
  const r = root.endsWith(sep) ? root : root + sep;
  return candidate === root || candidate.startsWith(r);
}
