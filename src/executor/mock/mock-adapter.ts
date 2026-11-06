import { targetKey, type ActionOutcome, type BrowserAdapter, type ExecAction, type PageEvent, type PageSession, type PageState, type RequestPolicy } from '../adapter.js';
import type { TargetT } from '../../contracts/index.js';

export interface MockPage {
  status?: number;
  title?: string;
  text?: string;
  counts?: Record<string, number>;
  console?: string[];
  requests?: { url: string; method?: string; status?: number }[];
  links?: Record<string, string>;
}
export interface MockSiteOpts {
  origin: string;
  pages: Record<string, MockPage>;
  actionDelayMs?: number;
  failAction?: (a: ExecAction) => string | undefined;
  settles?: boolean;
  /** Per-newContext hook (e.g. to count contexts for retry tests). */
  onContext?: () => void;
}

/** Scripted in-memory "site" for unit/integration tests: no browser is launched (AC-25). */
export class MockAdapter implements BrowserAdapter {
  contexts = 0;
  closed = 0;
  constructor(readonly opts: MockSiteOpts) {}
  async launch() {
    return {
      newContext: async (policy: RequestPolicy): Promise<PageSession> => {
        this.contexts++;
        this.opts.onContext?.();
        return new MockPageSession(this, policy);
      },
      close: async () => undefined,
    };
  }
}

class MockPageSession implements PageSession {
  private events: PageEvent[] = [];
  private url = 'about:blank';
  private page?: MockPage;
  constructor(private readonly a: MockAdapter, private readonly policy: RequestPolicy) {}

  private req(url: string, method: string, status: number | null, doc: boolean): void {
    const d = this.policy.check(url, method);
    if (!d.allow) {
      this.events.push({ kind: 'blocked', url, method, reason: d.reason });
      return;
    }
    this.events.push({ kind: 'network', url, method, status, same_origin: new URL(url).origin === this.a.opts.origin, is_document: doc });
  }
  private load(url: string): ActionOutcome {
    const u = new URL(url, this.a.opts.origin);
    const d = this.policy.check(u.href, 'GET');
    if (!d.allow) {
      this.events.push({ kind: 'blocked', url: u.href, method: 'GET', reason: d.reason });
      return { ok: false, error: 'navigation blocked' };
    }
    const p = this.a.opts.pages[u.pathname];
    this.url = u.href;
    this.page = p;
    this.req(u.href, 'GET', p ? (p.status ?? 200) : 404, true);
    for (const r of p?.requests ?? []) this.req(r.url, r.method ?? 'GET', r.status ?? 200, false);
    for (const c of p?.console ?? []) this.events.push({ kind: 'console', level: 'error', text: c });
    return { ok: true };
  }
  async perform(act: ExecAction, signal: AbortSignal): Promise<ActionOutcome> {
    const delay = this.a.opts.actionDelayMs ?? 0;
    if (delay > 0) {
      await new Promise<void>((res, rej) => {
        const t = setTimeout(res, delay);
        signal.addEventListener('abort', () => { clearTimeout(t); rej(new Error('aborted')); }, { once: true });
      });
    }
    const fail = this.a.opts.failAction?.(act);
    if (fail) return { ok: false, error: fail };
    switch (act.type) {
      case 'navigate': return this.load(act.url);
      case 'click': {
        const link = this.page?.links?.[targetKey(act.target)];
        return link ? this.load(link) : (this.page?.counts?.[targetKey(act.target)] ?? 0) > 0 ? { ok: true } : { ok: false, error: 'element not found' };
      }
      case 'wait_for': return (act.text ? this.page?.text?.includes(act.text) : (this.page?.counts?.[targetKey(act.target as TargetT)] ?? 0) > 0) ? { ok: true } : { ok: false, error: 'wait_for timed out' };
      default: return { ok: true };
    }
  }
  drainEvents(): PageEvent[] { const e = this.events; this.events = []; return e; }
  async state(): Promise<PageState> { return { url: this.url, title: this.page?.title ?? '', main_status: this.page ? (this.page.status ?? 200) : null }; }
  async hasText(t: string): Promise<boolean> { return (this.page?.text ?? '').includes(t); }
  async count(t: TargetT): Promise<number> { return this.page?.counts?.[targetKey(t)] ?? 0; }
  async settle(): Promise<boolean> { return this.a.opts.settles ?? true; }
  async close(): Promise<void> { this.a.closed++; }
}
