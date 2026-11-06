// The ONLY module that imports Playwright (NFR-10). No trace/HAR/video/screenshot capture: none can be redacted.
import { chromium, type Browser, type Page } from 'playwright';
import type { TargetT } from '../../contracts/index.js';
import type { ActionOutcome, BrowserAdapter, ExecAction, LaunchOptions, PageEvent, PageSession, PageState, RequestPolicy } from '../adapter.js';

export class PlaywrightAdapter implements BrowserAdapter {
  async launch(o: LaunchOptions) {
    // Preventive DNS boundary: only allow-listed hosts resolve inside the browser.
    const hosts = [...new Set(o.allowedOrigins.map((x) => new URL(x).hostname))];
    const rules = `MAP * ~NOTFOUND , ${hosts.map((h) => `EXCLUDE ${h}`).join(' , ')}`;
    const browser: Browser = await chromium.launch({ args: [`--host-resolver-rules=${rules}`], handleSIGINT: false, handleSIGTERM: false });
    return {
      newContext: async (policy: RequestPolicy): Promise<PageSession> => {
        const ctx = await browser.newContext({ viewport: { width: o.viewport.w, height: o.viewport.h }, locale: o.locale, timezoneId: o.timezone, serviceWorkers: 'block', acceptDownloads: false, permissions: [] });
        const events: PageEvent[] = [];
        const push = (e: PageEvent) => { if (events.length < o.maxEvents) events.push(e); };
        await ctx.route('**/*', async (route) => {
          const req = route.request();
          const d = policy.check(req.url(), req.method());
          if (!d.allow) { push({ kind: 'blocked', url: req.url(), method: req.method(), reason: d.reason }); await route.abort('blockedbyclient'); return; }
          await route.continue();
        });
        await ctx.routeWebSocket(/.*/, (ws) => { void ws.close(); });
        const page = await ctx.newPage();
        let mainStatus: number | null = null;
        page.on('console', (m) => push({ kind: 'console', level: m.type() === 'error' ? 'error' : 'log', text: m.text().slice(0, 1000) }));
        page.on('pageerror', (e) => push({ kind: 'console', level: 'error', text: String(e.message).slice(0, 1000) }));
        page.on('response', async (r) => {
          const doc = r.request().resourceType() === 'document' && r.request().frame() === page.mainFrame();
          if (doc) mainStatus = r.status();
          const same = new URL(r.url()).origin === new URL(page.url() === 'about:blank' ? r.url() : page.url()).origin;
          push({ kind: 'network', url: r.url(), method: r.request().method(), status: r.status(), same_origin: same, is_document: doc });
        });
        return new PwSession(page, events, () => mainStatus, async () => { await ctx.close(); });
      },
      close: async () => { await browser.close(); },
    };
  }
}

const loc = (page: Page, t: TargetT) =>
  t.test_id ? page.getByTestId(t.test_id) : t.role ? page.getByRole(t.role as Parameters<Page['getByRole']>[0], t.name ? { name: t.name } : {}) : page.getByText(t.text ?? '');

class PwSession implements PageSession {
  constructor(private page: Page, private events: PageEvent[], private status: () => number | null, private closer: () => Promise<void>) {}
  async perform(a: ExecAction, signal: AbortSignal): Promise<ActionOutcome> {
    try {
      const timeout = a.type === 'wait_for' ? a.timeout_ms : 10000;
      if (signal.aborted) return { ok: false, error: 'aborted' };
      switch (a.type) {
        case 'navigate': await this.page.goto(a.url, { timeout }); break;
        case 'click': await loc(this.page, a.target).click({ timeout }); break;
        case 'fill': await loc(this.page, a.target).fill(a.value, { timeout }); break;
        case 'select': await loc(this.page, a.target).selectOption(a.option, { timeout }); break;
        case 'press': await this.page.keyboard.press(a.key); break;
        case 'wait_for': await (a.text ? this.page.getByText(a.text) : loc(this.page, a.target as TargetT)).first().waitFor({ timeout }); break;
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message.split('\n')[0] ?? 'action failed' };
    }
  }
  drainEvents(): PageEvent[] { return this.events.splice(0, this.events.length); }
  async state(): Promise<PageState> { return { url: this.page.url(), title: await this.page.title(), main_status: this.status() }; }
  async hasText(t: string): Promise<boolean> { return this.page.getByText(t).first().isVisible(); }
  async count(t: TargetT): Promise<number> { return loc(this.page, t).count(); }
  async settle(ms: number): Promise<boolean> { try { await this.page.waitForLoadState('networkidle', { timeout: ms }); return true; } catch { return false; } }
  async close(): Promise<void> { await this.closer(); }
}
