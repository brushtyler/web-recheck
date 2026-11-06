import type { OracleT, SiteProfile } from '../contracts/index.js';
import type { PageEvent, PageSession } from '../executor/adapter.js';

export interface OracleOutcome { name: string; status: 'HELD' | 'VIOLATED' | 'NOT_EVALUABLE'; expected: unknown; actual: unknown; http_status?: number }
export interface OracleCtx { page: PageSession; events: PageEvent[]; invariants: SiteProfile['invariants']; evaluable: boolean; mainStatus: number | null }

const consoleErrors = (ctx: OracleCtx): string[] =>
  ctx.events.flatMap((e) => (e.kind === 'console' && e.level === 'error' && !ctx.invariants.console_allowlist.some((a) => e.text.includes(a)) ? [e.text] : []));

type Evaluator<T extends OracleT['type']> = (o: Extract<OracleT, { type: T }>, ctx: OracleCtx) => Promise<Omit<OracleOutcome, 'name'>>;

const held = (b: boolean, expected: unknown, actual: unknown) => ({ status: b ? ('HELD' as const) : ('VIOLATED' as const), expected, actual });

/** Closed evaluator registry: oracle types are data, never code (SEC-4). */
const EVALUATORS: { [K in OracleT['type']]: Evaluator<K> } = {
  text_visible: async (o, c) => held(await c.page.hasText(o.text), { text_visible: o.text }, 'text not visible'),
  element_present: async (o, c) => {
    const n = await c.page.count(o.target);
    return held(n > 0, { element_present: o.target }, `count=${n}`);
  },
  count_equals: async (o, c) => {
    const n = await c.page.count(o.target);
    return held(n === o.count, { count: o.count }, { count: n });
  },
  url_matches: async (o, c) => {
    const u = new URL((await c.page.state()).url);
    const ok = o.path !== undefined ? u.pathname === o.path : u.href.includes(o.contains ?? '\0');
    return held(ok, o.path ?? o.contains, u.pathname);
  },
  http_status: async (o, c) => {
    const nets = c.events.filter((e) => e.kind === 'network' && e.status !== null && (o.url_contains ? e.url.includes(o.url_contains) : e.is_document));
    const last = nets[nets.length - 1];
    if (!last || last.kind !== 'network') return { status: 'NOT_EVALUABLE', expected: o.status, actual: 'no matching response observed' };
    return held(last.status === o.status, o.status, last.status);
  },
  no_console_errors: async (_o, c) => {
    const errs = consoleErrors(c);
    return held(errs.length === 0, 'no console errors', errs.slice(0, 3));
  },
};

export async function evaluateOracle(o: OracleT, ctx: OracleCtx): Promise<OracleOutcome> {
  if (!ctx.evaluable) return { name: o.type, status: 'NOT_EVALUABLE', expected: o, actual: 'steps did not complete' };
  try {
    const ev = EVALUATORS[o.type] as Evaluator<typeof o.type>;
    const r = await ev(o as never, ctx);
    const out: OracleOutcome = { name: o.type, ...r };
    if (o.type === 'text_visible' || o.type === 'element_present' || o.type === 'count_equals' || o.type === 'url_matches') {
      if (ctx.mainStatus !== null) out.http_status = ctx.mainStatus;
    }
    return out;
  } catch (e) {
    return { name: o.type, status: 'NOT_EVALUABLE', expected: o, actual: `evaluation error: ${(e as Error).message}` };
  }
}

/** Cross-cutting invariants from the profile, evaluated over ALL drained events after the page settled. */
export function evaluateInvariants(ctx: OracleCtx): OracleOutcome[] {
  const out: OracleOutcome[] = [];
  if (ctx.invariants.no_console_errors) {
    const errs = consoleErrors(ctx);
    if (errs.length > 0) out.push({ name: 'invariant:no_console_errors', status: 'VIOLATED', expected: 'no console errors', actual: errs.slice(0, 3) });
  }
  if (ctx.invariants.no_same_origin_5xx) {
    const bad = ctx.events.filter((e) => e.kind === 'network' && e.same_origin && e.status !== null && e.status >= 500);
    const first = bad[0];
    if (first && first.kind === 'network' && first.status !== null) {
      out.push({ name: 'invariant:no_same_origin_5xx', status: 'VIOLATED', expected: 'no 5xx on same-origin requests', actual: bad.slice(0, 3).map((b) => (b.kind === 'network' ? `${b.status} ${b.url}` : '')), http_status: first.status });
    }
  }
  return out;
}
