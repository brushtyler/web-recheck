import type { TargetT } from '../../contracts/index.js';
import { createGuardedClient, type HttpClient } from '../../security/http.js';
import type { ActionOutcome, BrowserAdapter, ExecAction, LaunchOptions, PageEvent, PageSession, PageState, RequestPolicy } from '../adapter.js';

const strip = (html: string): string => html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const title = (html: string): string => /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? '';

/**
 * Browser-less engine ("http-lite"): fetches pages and sub-resources over the guarded client and evaluates
 * oracles against static HTML. No JavaScript runs. Meant for smoke suites and CI without a browser download.
 */
export class HttpLiteAdapter implements BrowserAdapter {
  async launch(o: LaunchOptions) {
    const http = createGuardedClient(o.allowedOrigins);
    return { newContext: async (p: RequestPolicy): Promise<PageSession> => new LiteSession(http, p, o), close: async () => undefined };
  }
}

class LiteSession implements PageSession {
  private events: PageEvent[] = [];
  private html = '';
  private url = 'about:blank';
  private status: number | null = null;
  constructor(private readonly http: HttpClient, private readonly policy: RequestPolicy, private readonly o: LaunchOptions) {}

  private push(e: PageEvent): void {
    if (this.events.length < this.o.maxEvents) this.events.push(e);
  }
  private async fetchOne(url: string, doc: boolean, signal?: AbortSignal): Promise<{ status: number; body: string } | null> {
    const d = this.policy.check(url, 'GET');
    if (!d.allow) { this.push({ kind: 'blocked', url, method: 'GET', reason: d.reason }); return null; }
    try {
      const r = await this.http.request({ url, method: 'GET', ...(signal ? { signal } : {}), timeoutMs: 10000 });
      this.push({ kind: 'network', url, method: 'GET', status: r.status, same_origin: new URL(url).origin === new URL(this.url === 'about:blank' ? url : this.url).origin, is_document: doc, body_preview: r.body.slice(0, 2048) });
      return { status: r.status, body: r.body };
    } catch (e) {
      this.push({ kind: 'console', level: 'error', text: `request failed: ${(e as Error).message}` });
      return null;
    }
  }
  private async load(url: string, signal: AbortSignal): Promise<ActionOutcome> {
    const r = await this.fetchOne(url, true, signal);
    if (!r) return { ok: false, error: 'navigation failed or blocked' };
    this.url = url; this.html = r.body; this.status = r.status;
    const subs = [...r.body.matchAll(/<(?:img|script|link|iframe)[^>]+(?:src|href)=["']([^"']+)["']/gi)].map((m) => m[1] as string);
    for (const s of subs.slice(0, 20)) {
      let abs: string;
      try { abs = new URL(s, url).href; } catch { continue; }
      await this.fetchOne(abs, false, signal);
    }
    return { ok: true };
  }
  private findLinks(t: TargetT): string | undefined {
    const text = t.text ?? t.name;
    for (const m of this.html.matchAll(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) if (text && strip(m[2] as string).trim() === text) return new URL(m[1] as string, this.url).href;
    return undefined;
  }
  async perform(a: ExecAction, signal: AbortSignal): Promise<ActionOutcome> {
    switch (a.type) {
      case 'navigate': return this.load(a.url, signal);
      case 'click': { const l = this.findLinks(a.target); return l ? this.load(l, signal) : { ok: false, error: 'only link clicks are supported by http-lite' }; }
      case 'wait_for': return (a.text ? strip(this.html).includes(a.text) : (await this.count(a.target as TargetT)) > 0) ? { ok: true } : { ok: false, error: 'wait_for: not found' };
      default: return { ok: false, error: `${a.type} is not supported by http-lite` };
    }
  }
  drainEvents(): PageEvent[] { const e = this.events; this.events = []; return e; }
  async state(): Promise<PageState> { return { url: this.url, title: title(this.html), main_status: this.status }; }
  async hasText(t: string): Promise<boolean> { return strip(this.html).includes(t); }
  async count(t: TargetT): Promise<number> {
    if (t.test_id) return [...this.html.matchAll(new RegExp(`data-testid=["']${t.test_id.replace(/[^\w-]/g, '')}["']`, 'gi'))].length;
    const text = t.text ?? t.name;
    if (t.role === 'link' && text) return this.findLinks({ text }) ? 1 : 0;
    if (t.role && text) return [...this.html.matchAll(new RegExp(`<${t.role === 'heading' ? 'h[1-6]' : t.role}[^>]*>([\\s\\S]*?)</`, 'gi'))].filter((m) => strip(m[1] as string).trim() === text).length;
    return text ? strip(this.html).split(text).length - 1 : 0;
  }
  async settle(): Promise<boolean> { return true; }
  async close(): Promise<void> { this.html = ''; }
}
