import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FixtureManager } from '../../src/fixture/manager.js';
import { Ledger, type Owner } from '../../src/fixture/ledger.js';
import { reap } from '../../src/fixture/reaper.js';
import { acquireReapLock, isRunActive, type Liveness } from '../../src/fixture/runlock.js';
import { resourceName } from '../../src/fixture/naming.js';
import { nullLogger } from '../../src/log/logger.js';
import { FakeHttp, ORIGIN, profile } from '../support/factory.js';

const owner = (case_id: string, worker = 'w0', attempt = 1, run = 'RUN1'): Owner => ({ run_id: run, shard_id: 's0', worker_id: worker, case_id, attempt });
function setup(over: { teardownTimeoutMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wr-fx-'));
  const ledger = new Ledger(join(dir, 'ledger.jsonl'));
  const http = new FakeHttp();
  const p = profile();
  const mgr = new FixtureManager({ runId: 'RUN1', siteId: 'test-site', baseUrl: ORIGIN, fixtures: p.fixtures, ledger, http, logger: nullLogger(), resolveSecret: () => 's', teardownTimeoutMs: over.teardownTimeoutMs ?? 500, requestTimeoutMs: 500 });
  return { dir, ledger, http, mgr, p };
}

describe('fixtures', () => {
  it('AC-20 writes PENDING intent before the create call, then CREATED', async () => {
    const { ledger, http, mgr } = setup();
    const seen: string[] = [];
    const orig = http.request.bind(http);
    http.request = async (r) => { seen.push(ledger.all().map((e) => e.status).join()); return orig(r); };
    const r = await mgr.scope(owner('c1')).create('item');
    expect(seen[0]).toBe('PENDING');
    expect(ledger.get(r.resource_key)).toMatchObject({ status: 'CREATED', owner: owner('c1'), name: r.name });
    expect(r.name.startsWith('wrchk_run1_')).toBe(true);
  });
  it('AC-21 teardown is idempotent', async () => {
    const { http, mgr } = setup();
    const s = mgr.scope(owner('c1'));
    const r = await s.create('item');
    expect(await s.teardown(r.resource_key)).toBe('done');
    const deletes = http.calls.filter((c) => c.method === 'DELETE').length;
    expect(await s.teardown(r.resource_key)).toBe('noop');
    expect(http.calls.filter((c) => c.method === 'DELETE').length).toBe(deletes);
    expect(await s.teardownAll()).toMatchObject({ quarantined: 0 });
  });
  it('AC-22 failed or timed-out teardown quarantines; resource is not reusable', async () => {
    const { ledger, http, mgr } = setup();
    http.failDelete = true;
    const s = mgr.scope(owner('c1'));
    const r = await s.create('item');
    expect(await s.teardown(r.resource_key)).toBe('quarantined');
    expect(ledger.quarantined()).toHaveLength(1);
    expect(() => s.get(r.resource_key)).toThrow(/not usable/);
    http.failDelete = false; http.hangDelete = true;
    const s2 = mgr.scope(owner('c2'));
    const r2 = await s2.create('item');
    expect(await s2.teardown(r2.resource_key)).toBe('quarantined');
  });
  it('AC-24 parallel scopes: unique names, no cross access', async () => {
    const { mgr } = setup();
    const a = mgr.scope(owner('c1', 'w0')), b = mgr.scope(owner('c1', 'w1'));
    const [ra, rb] = await Promise.all([a.create('item'), b.create('item')]);
    expect(ra.name).not.toBe(rb.name);
    expect(() => b.get(ra.resource_key)).toThrow(/FOREIGN_RESOURCE/);
    await expect(b.teardown(ra.resource_key)).rejects.toThrow(/FOREIGN_RESOURCE/);
    expect(a.get(ra.resource_key).id).toBeTruthy();
    expect(resourceName(owner('x'), 'item', 1)).not.toBe(resourceName(owner('x', 'w0', 1, 'RUN2'), 'item', 1));
  });
  it('rejected / failed creates and unknown kinds raise FIXTURE_FAILED; late creates are reconciled', async () => {
    const { ledger, http, mgr } = setup();
    const s = mgr.scope(owner('c1'));
    await expect(s.create('nope')).rejects.toThrow(/unknown fixture kind/);
    const orig = http.request.bind(http);
    http.request = async () => ({ status: 422, headers: {}, body: '' });
    await expect(s.create('item')).rejects.toThrow(/rejected/);
    expect(ledger.all().at(-1)?.status).toBe('CREATE_REJECTED');
    http.request = async () => { throw new Error('socket hang up'); };
    await expect(s.create('item')).rejects.toThrow(/FIXTURE|failed/);
    http.request = orig; // target recovered; ambiguous PENDING is reconciled by name -> not-found (template needs id, no lookup => quarantined)
    expect(await s.teardownAll()).toMatchObject({ quarantined: 1 });
  });
  it('ledger survives torn records and keeps latest state', async () => {
    const { dir, ledger, mgr } = setup();
    const r = await mgr.scope(owner('c1')).create('item');
    appendFileSync(join(dir, 'ledger.jsonl'), '{"torn":');
    const re = new Ledger(join(dir, 'ledger.jsonl'));
    expect(re.get(r.resource_key)?.status).toBe('CREATED');
    expect(re.open()).toHaveLength(1);
    expect(ledger.path).toBe(re.path);
  });
});

describe('reaper', () => {
  const live = (alive: boolean, host = 'h1', token: string | null = 't1'): Liveness => ({ host, pidAlive: () => alive, token: () => token, now: Date.now() });
  async function crashedRun(lock: object | null) {
    const { dir, http, mgr, p } = setup();
    const runs = join(dir, 'runs');
    const runDir = join(runs, 'RUN1');
    // re-point ledger into runs/RUN1
    const ledger = new Ledger(join(runDir, 'ledger.jsonl'));
    const m2 = new FixtureManager({ ...mgr.opts, ledger });
    const r = await m2.scope(owner('c1')).create('item');
    if (lock) writeFileSync(join(runDir, 'run.lock'), JSON.stringify(lock));
    return { runs, runDir, http, p, r, ledger };
  }
  const base = { pid: 4242, host: 'h1', start_token: 't1', started: 'x', heartbeat: '2000-01-01T00:00:00Z', state: 'running' };
  const run = (c: Awaited<ReturnType<typeof crashedRun>>, l: Liveness, dry = false) => reap({ runsDir: c.runs, profile: c.p, http: c.http, resolveSecret: () => 's', logger: nullLogger(), liveness: l, dryRun: dry });

  it('AC-23 removes resources of dead runs only and logs', async () => {
    const c = await crashedRun(base);
    expect((await run(c, live(true))).skipped_active).toEqual(['RUN1']); // stale heartbeat but live pid => active
    expect(c.http.items.size).toBe(1);
    expect((await run(c, live(true, 'h1', 'other-token'))).removed).toHaveLength(1); // PID reuse => dead
    expect(c.http.items.size).toBe(0);
    expect(new Ledger(join(c.runDir, 'ledger.jsonl')).open()).toHaveLength(0);
  });
  it('foreign host and fresh/unknown locks are treated as active (uncertain => active)', async () => {
    const c = await crashedRun({ ...base, host: 'other' });
    expect((await run(c, live(false))).skipped_active).toEqual(['RUN1']);
    const c2 = await crashedRun(null); // no lock, ledger just written
    expect((await run(c2, live(false))).skipped_active).toEqual(['RUN1']);
    expect(isRunActive(c2.runDir, join(c2.runDir, 'ledger.jsonl'), { ...live(false), now: Date.now() + 120_000 })).toBe(false);
  });
  it('dry-run removes nothing; finished runs are reapable; competing reapers are serialised', async () => {
    const c = await crashedRun({ ...base, state: 'finished' });
    await run(c, live(true), true);
    expect(c.http.items.size).toBe(1);
    const release = acquireReapLock(c.runs, live(true));
    expect(release).toBeTruthy();
    expect(acquireReapLock(c.runs, live(true))).toBeNull();
    expect((await run(c, live(true))).removed).toHaveLength(0); // locked out
    release?.();
    expect((await run(c, live(true))).removed).toHaveLength(1);
  });
});
