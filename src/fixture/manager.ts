import { errMessage, FrameworkError } from '../errors.js';
import type { FixtureSpecT } from '../contracts/index.js';
import type { Logger } from '../log/logger.js';
import type { HttpClient } from '../security/http.js';
import { Ledger, type Owner } from './ledger.js';
import { resourceName } from './naming.js';
import { buildRequest, executeTeardown, ownerVars } from './teardown.js';
import { extractPath } from './template.js';

export interface Resource {
  resource_key: string;
  kind: string;
  name: string;
  id: string;
}

export interface FixtureManagerOpts {
  runId: string;
  siteId: string;
  baseUrl: string;
  fixtures: Record<string, FixtureSpecT>;
  ledger: Ledger;
  http: HttpClient;
  logger: Logger;
  resolveSecret: (ref: string) => string;
  teardownTimeoutMs: number;
  requestTimeoutMs?: number;
}

export class FixtureManager {
  private seq = 0;
  private owners = new Map<string, Owner>();
  constructor(readonly opts: FixtureManagerOpts) {}

  scope(owner: Owner): FixtureScope {
    return new FixtureScope(this, owner);
  }
  nextSeq(): number {
    return ++this.seq;
  }
  register(key: string, owner: Owner): void {
    this.owners.set(key, owner);
  }
  ownerOf(key: string): Owner | undefined {
    return this.owners.get(key);
  }
  quarantined() {
    return this.opts.ledger.quarantined();
  }
}

const sameOwner = (a: Owner, b: Owner): boolean =>
  a.run_id === b.run_id && a.shard_id === b.shard_id && a.worker_id === b.worker_id && a.case_id === b.case_id && a.attempt === b.attempt;

/** Owner-bound view: a scope can only read/delete resources created under its own ownership key. */
export class FixtureScope {
  private inflight = new Set<Promise<unknown>>();
  private keys: string[] = [];
  constructor(
    private readonly mgr: FixtureManager,
    readonly owner: Owner,
  ) {}

  private log(event: string, f: Record<string, unknown> = {}): void {
    this.mgr.opts.logger.child({ component: 'fixture', case_id: this.owner.case_id, attempt: this.owner.attempt, worker_id: this.owner.worker_id, shard_id: this.owner.shard_id }).info(event, f);
  }

  async create(kind: string): Promise<Resource> {
    const o = this.mgr.opts;
    const spec = o.fixtures[kind];
    if (!spec) throw new FrameworkError('FIXTURE_FAILED', `unknown fixture kind "${kind}"`);
    const seq = this.mgr.nextSeq();
    const name = resourceName(this.owner, kind, seq);
    const key = `${this.owner.run_id}:${seq}`;
    this.mgr.register(key, this.owner);
    this.keys.push(key);
    // Durable intent first: the deterministic name makes an ambiguous create recoverable.
    o.ledger.append({ site_id: o.siteId, resource_key: key, status: 'PENDING', owner: this.owner, kind, name });
    const work = (async () => {
      const vars = { ...ownerVars(this.owner), 'resource.name': name };
      const res = await o.http.request({
        ...buildRequest(o.baseUrl, spec.create, vars, o.resolveSecret),
        signal: AbortSignal.timeout(o.requestTimeoutMs ?? 15000),
        timeoutMs: o.requestTimeoutMs ?? 15000,
      });
      if (res.status >= 400 && res.status < 500) {
        o.ledger.append({ site_id: o.siteId, resource_key: key, status: 'CREATE_REJECTED', owner: this.owner, kind, name, reason: `status ${res.status}` });
        throw new FrameworkError('FIXTURE_FAILED', `create ${kind} rejected with status ${res.status}`);
      }
      if (res.status < 200 || res.status >= 300) throw new FrameworkError('FIXTURE_FAILED', `create ${kind} failed with status ${res.status}`);
      let id: string | undefined;
      try {
        id = extractPath(JSON.parse(res.body), spec.id_path);
      } catch {
        id = undefined;
      }
      if (!id) throw new FrameworkError('FIXTURE_FAILED', `create ${kind}: id not found at "${spec.id_path}"`);
      o.ledger.append({ site_id: o.siteId, resource_key: key, status: 'CREATED', owner: this.owner, kind, name, resource_id: id });
      this.log('fixture_created', { kind, resource_key: key, name });
      return { resource_key: key, kind, name, id } as Resource;
    })();
    this.inflight.add(work);
    try {
      return await work;
    } catch (e) {
      if (e instanceof FrameworkError) throw e;
      throw new FrameworkError('FIXTURE_FAILED', `create ${kind} failed: ${errMessage(e)}`);
    } finally {
      this.inflight.delete(work);
    }
  }

  private check(key: string): void {
    const owner = this.mgr.ownerOf(key);
    if (!owner || !sameOwner(owner, this.owner)) throw new FrameworkError('FOREIGN_RESOURCE', `FOREIGN_RESOURCE: ${key} is not owned by this scope`);
  }

  get(key: string): Resource {
    this.check(key);
    const e = this.mgr.opts.ledger.get(key);
    if (!e || e.status !== 'CREATED' || !e.resource_id) throw new FrameworkError('FIXTURE_FAILED', `resource ${key} is not usable (${e?.status ?? 'unknown'})`);
    return { resource_key: key, kind: e.kind, name: e.name, id: e.resource_id };
  }

  /** Names and ids of live resources owned by this attempt (used by the mutation guard). */
  ownedIdentifiers(): Set<string> {
    const s = new Set<string>();
    for (const k of this.keys) {
      const e = this.mgr.opts.ledger.get(k);
      if (e && (e.status === 'CREATED' || e.status === 'PENDING')) {
        s.add(e.name);
        if (e.resource_id) s.add(e.resource_id);
      }
    }
    return s;
  }

  async teardown(key: string): Promise<'done' | 'noop' | 'quarantined'> {
    this.check(key);
    const o = this.mgr.opts;
    const e = o.ledger.get(key);
    if (!e || e.status === 'TORN_DOWN' || e.status === 'CREATE_REJECTED') return 'noop';
    const spec = o.fixtures[e.kind];
    try {
      if (!spec) throw new Error('fixture kind no longer declared');
      await executeTeardown(spec, e, { baseUrl: o.baseUrl, http: o.http, resolveSecret: o.resolveSecret, timeoutMs: o.teardownTimeoutMs });
      o.ledger.append({ site_id: o.siteId, resource_key: key, status: 'TORN_DOWN', owner: e.owner, kind: e.kind, name: e.name });
      this.log('fixture_torn_down', { kind: e.kind, resource_key: key });
      return 'done';
    } catch (err) {
      o.ledger.append({ site_id: o.siteId, resource_key: key, status: 'QUARANTINED', owner: e.owner, kind: e.kind, name: e.name, reason: errMessage(err).slice(0, 200) });
      o.logger.child({ component: 'fixture', case_id: e.owner.case_id }).warn('fixture_quarantined', { kind: e.kind, resource_key: key, reason: errMessage(err).slice(0, 200) });
      return 'quarantined';
    }
  }

  /** Reverse-order, idempotent teardown. In-flight creates are awaited first so a late create cannot orphan. */
  async teardownAll(): Promise<{ done: number; noop: number; quarantined: number }> {
    const budget = this.mgr.opts.teardownTimeoutMs;
    if (this.inflight.size > 0) {
      await Promise.race([Promise.allSettled([...this.inflight]), new Promise((r) => setTimeout(r, budget).unref())]);
    }
    const out = { done: 0, noop: 0, quarantined: 0 };
    for (const k of [...this.keys].reverse()) out[await this.teardown(k)]++;
    return out;
  }

  keysCreated(): string[] {
    return [...this.keys];
  }
}
