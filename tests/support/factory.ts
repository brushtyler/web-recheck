import { validateDocument, type CaseT, type SiteProfile, type CaseRegistry } from '../../src/contracts/index.js';
import { computeContentHash } from '../../src/registry/lifecycle.js';
import type { HttpClient, HttpRequest } from '../../src/security/http.js';

export const ORIGIN = 'http://127.0.0.1:4999';

export function profile(over: Record<string, unknown> = {}): SiteProfile {
  return validateDocument('site_profile', {
    schema_version: '1', site_id: 'test-site', environment: 'beta', base_url: ORIGIN, allowed_origins: [ORIGIN],
    fixtures: { item: { create: { method: 'POST', path: '/api/items', body: { name: '${resource.name}' } }, teardown: { method: 'DELETE', path: '/api/items/${resource.id}' } } },
    mutation_endpoints: [{ method: 'DELETE', path: '/api/items/{owned}' }],
    limits: { case_timeout_ms: 2000, max_retries: 3, teardown_timeout_ms: 2000 },
    ...over,
  });
}

export function makeCase(id: string, over: Partial<CaseT> = {}): CaseT {
  const base = {
    case_id: id, title: id, state: 'EXECUTABLE', case_revision: 1, mutating: false, parameters: {},
    steps: [{ type: 'navigate', path: '/ok' }], oracles: [{ type: 'text_visible', text: 'Welcome' }], ...over,
  } as CaseT;
  const hash = computeContentHash(base);
  const c = { ...base, content_hash: hash } as CaseT;
  if (c.state === 'EXECUTABLE' && !over.approval) c.approval = { approved_by: 'qa', approved_at: '2026-01-01T00:00:00.000Z', approved_revision: c.case_revision, approved_content_hash: hash };
  return c;
}

export const registry = (...cases: CaseT[]): CaseRegistry => ({ schema_version: '1', site_id: 'test-site', cases });

/** In-memory fake of the target's CRUD API; records calls. */
export class FakeHttp implements HttpClient {
  calls: HttpRequest[] = [];
  items = new Map<string, string>();
  failDelete = false;
  hangDelete = false;
  async request(req: HttpRequest) {
    this.calls.push(req);
    const u = new URL(req.url);
    if (req.method === 'POST' && u.pathname === '/api/items') {
      const id = `id${this.items.size + 1}`;
      this.items.set(id, (JSON.parse(req.body ?? '{}') as { name: string }).name);
      return { status: 201, headers: {}, body: JSON.stringify({ id }) };
    }
    if (req.method === 'DELETE') {
      if (this.hangDelete) await new Promise((_r, rej) => req.signal?.addEventListener('abort', () => rej(new Error('timeout'))));
      if (this.failDelete) return { status: 500, headers: {}, body: '' };
      const id = decodeURIComponent(u.pathname.split('/').pop() ?? '');
      if (!this.items.delete(id)) return { status: 404, headers: {}, body: '' };
      return { status: 204, headers: {}, body: '' };
    }
    return { status: 400, headers: {}, body: '' };
  }
}
