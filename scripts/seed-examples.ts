// Regenerates examples/*/cases.yaml with valid hashes/approvals (seed subset; approver recorded as "seed-bootstrap").
import type { CaseT } from '../src/contracts/index.js';
import { computeContentHash } from '../src/registry/lifecycle.js';
import { writeRegistry } from '../src/registry/registry.js';

type Draft = Pick<CaseT, 'case_id' | 'title' | 'steps' | 'oracles'> & Partial<Pick<CaseT, 'state' | 'mutating' | 'parameters' | 'source'>>;

function make(d: Draft): CaseT {
  const base = { mutating: false, parameters: {}, ...d };
  const hash = computeContentHash(base as CaseT);
  const state = d.state ?? 'EXECUTABLE';
  const c = { ...base, state, case_revision: 1, content_hash: hash } as CaseT;
  if (state === 'EXECUTABLE') c.approval = { approved_by: 'seed-bootstrap', approved_at: '2026-11-06T00:00:00.000Z', approved_revision: 1, approved_content_hash: hash };
  return c;
}

writeRegistry('examples/gestionale/cases.yaml', {
  schema_version: '1', site_id: 'gestionale',
  cases: [
    make({ case_id: 'GST-LOGIN-001', title: 'Login page is reachable', source: { inventory_id: 'AUTH-001' }, steps: [{ type: 'navigate', path: '/login' }], oracles: [{ type: 'text_visible', text: 'Accedi' }, { type: 'http_status', status: 200 }] }),
    make({ case_id: 'GST-DASH-001', title: 'Dashboard lists rows', source: { inventory_id: 'DASH-001' }, steps: [{ type: 'navigate', path: '/dashboard' }], oracles: [{ type: 'count_equals', target: { test_id: 'row' }, count: 2 }] }),
    make({ case_id: 'GST-DISC-001', title: 'Discovered, not yet approved', state: 'DISCOVERED', steps: [{ type: 'navigate', path: '/ok' }], oracles: [{ type: 'text_visible', text: 'Welcome' }] }),
  ],
});
writeRegistry('examples/beta-portal/cases.yaml', {
  schema_version: '1', site_id: 'beta-portal',
  cases: [
    make({ case_id: 'BETA-HOME-001', title: 'Home shows welcome', steps: [{ type: 'navigate', path: '/ok' }], oracles: [{ type: 'text_visible', text: 'Welcome' }] }),
    make({ case_id: 'BETA-NAV-001', title: 'Navigate to dashboard via link', steps: [{ type: 'navigate', path: '/ok' }, { type: 'click', target: { role: 'link', name: 'Dashboard' } }], oracles: [{ type: 'url_matches', path: '/dashboard' }] }),
    make({ case_id: 'BETA-ITEM-001', title: 'Item fixture lifecycle', mutating: true, steps: [{ type: 'fixture', kind: 'item', as: 'it' }, { type: 'navigate', path: '/ok' }], oracles: [{ type: 'text_visible', text: 'Welcome' }] }),
  ],
});
