import { mkdtempSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { FrameworkError } from '../../src/errors.js';
import { SCHEMAS, loadDocument, validateDocument } from '../../src/contracts/index.js';
import { parseYamlSafe } from '../../src/security/safe-yaml.js';
import { resolveInside } from '../../src/security/paths.js';
import { readText } from '../../src/io/files.js';
import { profile, ORIGIN } from '../support/factory.js';

const base = { schema_version: '1', site_id: 'x', environment: 'beta', base_url: ORIGIN, allowed_origins: [ORIGIN] };
const err = (f: () => unknown): FrameworkError => { try { f(); } catch (e) { return e as FrameworkError; } throw new Error('no throw'); };

describe('contracts', () => {
  it('AC-1 reports JSON pointer paths', () => {
    const e = err(() => validateDocument('site_profile', { ...base, limits: { max_retries: 9 } }));
    expect(e.code).toBe('SCHEMA_VIOLATION');
    expect(e.issues.map((i) => i.path)).toContain('/limits/max_retries');
  });
  it('AC-2 unknown top-level fields fail', () => {
    expect(err(() => validateDocument('site_profile', { ...base, extra: 1 })).issues[0]?.code).toBe('unrecognized_keys');
  });
  it('AC-3 unsupported schema_version', () => {
    expect(err(() => validateDocument('site_profile', { ...base, schema_version: '9' })).code).toBe('UNSUPPORTED_SCHEMA_VERSION');
  });
  it('SEC-2 plaintext credentials are rejected', () => {
    const e = err(() => validateDocument('site_profile', { ...base, auth: { strategy: 'form_login', login_path: '/l', username_ref: 'admin', password_ref: 'hunter2', username_target: { test_id: 'u' }, password_target: { test_id: 'p' }, submit_target: { test_id: 's' } } }));
    expect(e.issues.some((i) => i.path === '/auth/password_ref')).toBe(true);
    expect(err(() => validateDocument('site_profile', { ...base, api_token: 'abc' })).code).toBe('PLAINTEXT_SECRET');
  });
  it('A1 metadata base_url is rejected', () => {
    for (const u of ['http://169.254.169.254/', 'http://metadata.google.internal/', 'http://[fd00:ec2::254]/', 'http://0.0.0.0/', 'http://100.100.100.200/']) {
      expect(() => validateDocument('site_profile', { ...base, base_url: u, allowed_origins: [u] }), u).toThrow();
    }
    expect(() => validateDocument('site_profile', { ...base, base_url: 'file:///etc/passwd', allowed_origins: ['file:///etc'] })).toThrow();
  });
  it('limits are bounded (SEC-10)', () => {
    expect(() => profile({ limits: { max_workers: 9 } })).toThrow();
    expect(() => profile({ limits: { case_timeout_ms: 5 } })).toThrow();
  });
  it('A3 YAML tags / merge keys / alias bombs are rejected', () => {
    expect(() => parseYamlSafe('a: !!js/function "function(){}"')).toThrow(/unsafe/i);
    expect(() => parseYamlSafe('a: !!python/object:os.system x')).toThrow();
    expect(() => parseYamlSafe('base: &b {x: 1}\nd:\n  <<: *b')).not.toThrow(); // merge disabled: plain key, not expanded
    const bomb = 'a: &a [x]\n' + Array.from({ length: 80 }, (_v, i) => `k${i}: *a`).join('\n');
    expect(() => parseYamlSafe(bomb)).toThrow();
    expect(() => parseYamlSafe('a: ' + 'x'.repeat(1024 * 1024 + 1))).toThrow();
  });
  it('A2 path traversal / absolute / symlink escape are rejected', () => {
    const root = mkdtempSync(join(tmpdir(), 'wr-'));
    expect(() => resolveInside(root, '../../etc/passwd')).toThrow(/escapes/);
    expect(() => resolveInside(root, '/etc/passwd')).toThrow();
    symlinkSync('/etc', join(root, 'link'));
    expect(() => resolveInside(root, 'link/passwd')).toThrow(/symlink/);
    expect(resolveInside(root, 'a/b.json')).toBe(join(root, 'a/b.json'));
  });
  it('loadDocument reads YAML and rejects bad files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wr-'));
    writeFileSync(join(dir, 'p.yaml'), `schema_version: "1"\nsite_id: a\nenvironment: beta\nbase_url: ${ORIGIN}\nallowed_origins: [${ORIGIN}]\n`);
    expect(loadDocument('site_profile', join(dir, 'p.yaml')).limits.max_retries).toBe(0);
    writeFileSync(join(dir, 'bad.json'), '{nope');
    expect(() => loadDocument('site_profile', join(dir, 'bad.json'))).toThrow();
  });
  it('generated JSON schemas are in sync with zod (D2)', () => {
    for (const [name, schema] of Object.entries(SCHEMAS)) {
      const disk = JSON.parse(readText(`schemas/${name}.schema.json`));
      expect(disk).toEqual(JSON.parse(JSON.stringify(z.toJSONSchema(schema as z.ZodType, { unrepresentable: 'any' }))));
    }
  });
});
