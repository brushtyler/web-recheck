import { hostname } from 'node:os';
import { join } from 'node:path';
import { exists, mtimeMs, readText, remove, tryCreateExclusive, writeAtomic } from '../io/files.js';

export interface LockInfo {
  pid: number;
  host: string;
  start_token: string | null;
  started: string;
  heartbeat: string;
  state: 'running' | 'finished';
}

export function processToken(pid: number): string | null {
  try {
    const stat = readText(`/proc/${pid}/stat`, 8192);
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null; // field 22: starttime
  } catch {
    return null;
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class RunLock {
  private timer?: NodeJS.Timeout;
  constructor(private readonly dir: string) {}
  private get file(): string {
    return join(this.dir, 'run.lock');
  }
  private write(state: LockInfo['state'], started: string): void {
    const info: LockInfo = { pid: process.pid, host: hostname(), start_token: processToken(process.pid), started, heartbeat: new Date().toISOString(), state };
    writeAtomic(this.file, JSON.stringify(info));
  }
  acquire(): void {
    const started = new Date().toISOString();
    this.write('running', started);
    this.timer = setInterval(() => this.write('running', started), 5000);
    this.timer.unref();
  }
  release(): void {
    if (this.timer) clearInterval(this.timer);
    this.write('finished', new Date().toISOString());
  }
}

export interface Liveness {
  host: string;
  pidAlive: (pid: number) => boolean;
  token: (pid: number) => string | null;
  now: number;
}
export const defaultLiveness = (): Liveness => ({ host: hostname(), pidAlive, token: processToken, now: Date.now() });

/**
 * Conservative: uncertain => active. A heartbeat alone never declares a run dead; only a finished lock,
 * a dead pid, or a pid whose start token changed (PID reuse) does. Foreign hosts are always "active" (v1: local reaping only).
 */
export function isRunActive(runDir: string, ledgerPath: string, l: Liveness = defaultLiveness()): boolean {
  const lockPath = join(runDir, 'run.lock');
  if (!exists(lockPath)) {
    const m = mtimeMs(ledgerPath);
    return m !== null && l.now - m < 60_000;
  }
  let info: LockInfo;
  try {
    info = JSON.parse(readText(lockPath, 65536)) as LockInfo;
  } catch {
    return true;
  }
  if (info.state === 'finished') return false;
  if (info.host !== l.host) return true;
  if (!l.pidAlive(info.pid)) return false;
  const cur = l.token(info.pid);
  if (cur && info.start_token && cur !== info.start_token) return false;
  return true;
}

/** Serialises competing reapers; a stale reap lock (dead pid) is taken over. */
export function acquireReapLock(runsDir: string, l: Liveness = defaultLiveness()): (() => void) | null {
  const path = join(runsDir, '.reap.lock');
  const body = JSON.stringify({ pid: process.pid, host: l.host });
  if (!tryCreateExclusive(path, body)) {
    try {
      const cur = JSON.parse(readText(path, 4096)) as { pid: number; host: string };
      if (cur.host !== l.host || l.pidAlive(cur.pid)) return null;
    } catch {
      return null;
    }
    writeAtomic(path, body);
  }
  return () => remove(path);
}
