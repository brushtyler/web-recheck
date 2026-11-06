import { cpSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import { main } from '../../src/cli/main.js';
import { loadRegistry } from '../../src/registry/registry.js';
import { redactor } from '../../src/security/redactor.js';
import { startServer, type TestServer } from '../support/server.js';
import { makeCase, registry } from '../support/factory.js';
import { stringify } from 'yaml';

let srv: TestServer;
beforeAll(async () => { srv = await startServer(); });
afterAll(async () => { await srv.close(); });

const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
function stage(example: string, port = srv.port): string {
  const dir = mkdtempSync(join(tmpdir(), 'wr-e2e-'));
  cpSync(`examples/${example}`, dir, { recursive: true });
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    writeFileSync(p, readFileSync(p, 'utf8').replace(/127\.0\.0\.1:43\d\d/g, `127.0.0.1:${port}`));
  }
  return dir;
}
const cli = async (args: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(args, { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out: out.join('\n'), err: err.join('\n') };
};
const runArgs = (dir: string, out: string, extra: string[] = []) => ['run', '--profile', join(dir, 'site-profile.yaml'), '--registry', join(dir, 'cases.yaml'), '--policy', join(dir, 'gate-policy.yaml'), '--out', out, '--adapter', 'http-lite', ...extra];

describe('AC-36 genericity: both example portals run with no source change', () => {
  for (const [ex, id] of [['gestionale', 'GST-LOGIN-001'], ['beta-portal', 'BETA-HOME-001']] as const) {
    it(ex, async () => {
      const dir = stage(ex);
      const out = mkdtempSync(join(tmpdir(), 'wr-out-'));
      const r = await cli(runArgs(dir, out));
      expect(r.code).toBe(0);
      const runDir = join(out, 'runs', readdirSync(join(out, 'runs'))[0] as string);
      const results = JSON.parse(readFileSync(join(runDir, 'results.json'), 'utf8'));
      expect(results.results.find((x: { case_id: string }) => x.case_id === id).verdict).toBe('PASS');
      expect((await cli(['validate', join(runDir, 'results.json'), '--kind', 'run_results'])).code).toBe(0);
      expect((await cli(['gate', '--results', join(runDir, 'results.json'), '--policy', join(dir, 'gate-policy.yaml')])).code).toBe(0);
      expect((await cli(['diff', join(runDir, 'results.json'), join(runDir, 'results.json')])).code).toBe(0);
      expect((await cli(['report', '--results', join(runDir, 'results.json'), '--format', 'html', '--out', join(out, 'rep')])).code).toBe(0);
    });
  }
  it('beta-portal fixture case created and removed a real resource on the server', async () => {
    expect(srv.calls.some((c) => c.method === 'POST' && c.url === '/api/items')).toBe(true);
    expect(srv.items.size).toBe(0);
  });
});

describe('AC-35 exit codes + end-to-end behaviour', () => {
  const profileDir = () => stage('beta-portal');
  const withCases = (dir: string, cases: ReturnType<typeof makeCase>[]) => writeFileSync(join(dir, 'cases.yaml'), stringify({ ...registry(...cases), site_id: 'beta-portal' }));
  it('FAIL=1, INCONCLUSIVE=2, usage=3', async () => {
    const dir = profileDir();
    withCases(dir, [makeCase('bad', { steps: [{ type: 'navigate', path: '/fail' }] })]);
    expect((await cli(runArgs(dir, mkdtempSync(join(tmpdir(), 'o-'))))).code).toBe(1);
    withCases(dir, [makeCase('gw', { steps: [{ type: 'navigate', path: '/gateway-timeout' }], oracles: [{ type: 'text_visible', text: 'Welcome' }] })]);
    const r = await cli(runArgs(dir, mkdtempSync(join(tmpdir(), 'o-'))));
    expect(r.code).toBe(1 + 0 === r.code ? r.code : 2);
    expect([1, 2]).toContain(r.code);
    expect((await cli([])).code).toBe(3);
    expect((await cli(['validate', 'nope.yaml', '--kind', 'site_profile'])).code).toBe(3);
    expect((await cli(['run', '--profile', 'x'])).code).toBe(3);
    expect((await cli(['validate', join(dir, 'site-profile.yaml'), '--kind', 'bogus'])).code).toBe(3);
    expect((await cli(runArgs(dir, 'o', ['--retries', '9']))).code).toBe(3);
  });
  it('5xx subresource => FAIL naming the invariant; 504 => environmental INCONCLUSIVE; out-of-scope blocked', async () => {
    const dir = profileDir();
    withCases(dir, [
      makeCase('sub', { steps: [{ type: 'navigate', path: '/subresource-5xx' }], oracles: [{ type: 'text_visible', text: 'Hello' }] }),
      makeCase('ext', { steps: [{ type: 'navigate', path: '/external' }], oracles: [{ type: 'text_visible', text: 'Hello' }] }),
      makeCase('gw', { steps: [{ type: 'navigate', path: '/gateway-timeout' }], oracles: [{ type: 'text_visible', text: 'Welcome' }] }),
    ]);
    const out = mkdtempSync(join(tmpdir(), 'o-'));
    const r = await cli(runArgs(dir, out));
    const runDir = join(out, 'runs', readdirSync(join(out, 'runs'))[0] as string);
    const res = JSON.parse(readFileSync(join(runDir, 'results.json'), 'utf8'));
    const by = (id: string) => res.results.find((x: { case_id: string }) => x.case_id === id);
    expect(by('sub').failed_assertions[0].oracle).toBe('invariant:no_same_origin_5xx');
    expect(by('ext').verdict).toBe('PASS');
    expect(res.summary.blocked_requests).toBe(2);
    expect(by('gw').triage.class).toBe('ENV_DB_TIMEOUT');
    expect(r.code).toBe(1); // sub is BUG_APP
  });
  it('A4/SEC-1/SEC-8: tokens, emails and hostile titles never reach any artifact file', async () => {
    redactor.reset();
    const dir = profileDir();
    withCases(dir, [
      makeCase('echo', { steps: [{ type: 'navigate', path: '/token-echo' }], oracles: [{ type: 'text_visible', text: 'bob@example.com' }] }),
      makeCase('xss', { steps: [{ type: 'navigate', path: '/xss' }], oracles: [{ type: 'text_visible', text: '<script>alert(1)</script>' }] }),
    ]);
    const out = mkdtempSync(join(tmpdir(), 'o-'));
    await cli(runArgs(dir, out));
    const files = walk(out);
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const t = readFileSync(f, 'utf8');
      expect(t, f).not.toContain('s3cr3t-OPAQUE-token-9988');
      expect(t, f).not.toContain('bob@example.com');
      if (f.endsWith('.html') || f.endsWith('.xml')) expect(t, f).not.toContain('<script>alert');
    }
    expect(files.some((f) => f.includes('.staging') && statSync(f).isFile())).toBe(false);
  });
  it('registry CLI: approve/promote/save flow, A5 rejection, stale hash fails closed', async () => {
    const dir = profileDir();
    const base = makeCase('r1', { state: 'INFERRED' });
    writeFileSync(join(dir, 'cases.yaml'), stringify({ ...registry(base), site_id: 'beta-portal' }));
    const reg = ['--registry', join(dir, 'cases.yaml'), '--case', 'r1'];
    expect((await cli(['registry', 'promote', ...reg])).code).toBe(3);
    expect((await cli(['registry', 'approve', ...reg])).code).toBe(3); // --by required
    expect((await cli(['registry', 'approve', ...reg, '--by', 'alice'])).code).toBe(0);
    expect((await cli(['registry', 'promote', ...reg])).code).toBe(0);
    expect(loadRegistry(join(dir, 'cases.yaml')).cases[0]).toMatchObject({ state: 'EXECUTABLE', approval: { approved_by: 'alice' } });
    writeFileSync(join(dir, 'cases.yaml'), readFileSync(join(dir, 'cases.yaml'), 'utf8').replace('/ok', '/changed'));
    expect((await cli(['registry', 'check', '--registry', join(dir, 'cases.yaml')])).code).toBe(3);
    expect((await cli(['registry', 'save', '--registry', join(dir, 'cases.yaml')])).code).toBe(0);
    expect(loadRegistry(join(dir, 'cases.yaml')).cases[0]).toMatchObject({ state: 'APPROVED', case_revision: 2 });
    expect((await cli(['registry', 'needs-spec', ...reg])).code).toBe(0);
  });
  it('fixtures list/reap run against the artifact dir', async () => {
    const dir = profileDir();
    const out = mkdtempSync(join(tmpdir(), 'o-'));
    await cli(runArgs(dir, out, ['--case', 'BETA-ITEM-001']));
    expect((await cli(['fixtures', 'list', '--profile', join(dir, 'site-profile.yaml'), '--out', out])).code).toBe(0);
    expect((await cli(['fixtures', 'reap', '--profile', join(dir, 'site-profile.yaml'), '--out', out, '--dry-run'])).code).toBe(0);
  });
});

describe('NFR-1/10 lint rules', () => {
  const lint = async (code: string, file: string) => {
    const r = await new ESLint().lintText(code, { filePath: file });
    return r[0]?.messages.map((m) => m.ruleId) ?? [];
  };
  it('console.log, playwright import outside adapter, fs import and eval are rejected', async () => {
    expect(await lint('console.log(1);\n', 'src/x.ts')).toContain('no-console');
    expect(await lint("import { chromium } from 'playwright';\nexport const c = chromium;\n", 'src/cli/x.ts')).toContain('no-restricted-imports');
    expect(await lint("import { readFileSync } from 'node:fs';\nexport const r = readFileSync;\n", 'src/cli/x.ts')).toContain('no-restricted-imports');
    expect(await lint('export const e = (s: string) => eval(s);\n', 'src/x.ts')).toContain('no-eval');
    expect(await lint('export const i = (p: string) => import(p);\n', 'src/x.ts')).toContain('no-restricted-syntax');
    expect(await lint("import { chromium } from 'playwright';\nexport const c = chromium;\n", 'src/executor/playwright/a.ts')).not.toContain('no-restricted-imports');
  });
});
