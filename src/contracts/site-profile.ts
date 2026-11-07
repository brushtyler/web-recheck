import { z } from 'zod';
import { SchemaVersion, SecretRef, SiteId, TriageClass } from './common.js';
import { isAllowed } from '../security/scope.js';

const Url = z.url({ protocol: /^https?$/ });
const Scalar = z.union([z.string(), z.number(), z.boolean()]);
export const Target = z
  .strictObject({ role: z.string().max(60).optional(), test_id: z.string().max(100).optional(), text: z.string().max(200).optional(), name: z.string().max(200).optional() })
  .refine((t) => [t.role, t.test_id, t.text].filter((x) => x !== undefined).length === 1, 'exactly one of role, test_id, text is required');

const HttpRequestSpec = z.strictObject({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: z.string().regex(/^\/(?!\/)/, 'path must be relative and start with a single /').max(300),
  body: z.record(z.string(), Scalar).optional(),
  auth_ref: SecretRef.optional(),
});

export const FixtureSpec = z.strictObject({
  create: HttpRequestSpec,
  id_path: z.string().regex(/^[A-Za-z0-9_.]+$/).default('id'),
  teardown: HttpRequestSpec,
  lookup: HttpRequestSpec.optional(),
});

export const TriageRule = z.strictObject({
  rule_id: z.string().regex(/^[A-Za-z0-9._-]{1,60}$/),
  class: TriageClass,
  confidence: z.number().min(0).max(1),
  match: z
    .strictObject({
      phase: z.enum(['setup', 'steps', 'oracles', 'teardown']).optional(),
      source: z.enum(['oracle', 'invariant', 'setup', 'timeout', 'action', 'scope', 'flaky', 'abort']).optional(),
      name: z.string().max(100).optional(),
      http_status: z.array(z.number().int().min(100).max(599)).min(1).optional(),
      contains: z.string().min(1).max(200).optional(),
      reason_code: z.string().max(60).optional(),
    })
    .refine((m) => Object.values(m).some((v) => v !== undefined), 'match must have at least one condition'),
});

const Auth = z.discriminatedUnion('strategy', [
  z.strictObject({ strategy: z.literal('none') }),
  z.strictObject({
    strategy: z.literal('form_login'),
    login_path: z.string().regex(/^\/(?!\/)/),
    username_ref: SecretRef,
    password_ref: SecretRef,
    username_target: Target,
    password_target: Target,
    submit_target: Target,
    success_text: z.string().max(200).optional(),
  }),
]);

export const Limits = z.strictObject({
  case_timeout_ms: z.number().int().min(1000).max(300000).default(30000),
  run_timeout_ms: z.number().int().min(1000).max(14400000).default(1800000),
  teardown_timeout_ms: z.number().int().min(1000).max(120000).default(30000),
  max_retries: z.number().int().min(0).max(5).default(0),
  max_workers: z.number().int().min(1).max(8).default(1),
  max_artifact_bytes_per_case: z.number().int().min(1024).max(20 * 1024 * 1024).default(5 * 1024 * 1024),
  max_events_per_attempt: z.number().int().min(100).max(10000).default(2000),
});

export const SiteProfileSchema = z
  .strictObject({
    schema_version: SchemaVersion,
    site_id: SiteId,
    environment: z.enum(['beta', 'staging', 'production']),
    base_url: Url,
    allowed_origins: z.array(Url).min(1),
    auth: Auth.default({ strategy: 'none' }),
    browser: z
      .strictObject({
        engine: z.enum(['chromium', 'http-lite']).default('chromium'),
        viewport: z.strictObject({ w: z.number().int().min(200).max(4000), h: z.number().int().min(200).max(4000) }).default({ w: 1280, h: 800 }),
        locale: z.string().max(20).default('en-US'),
        timezone: z.string().max(60).default('UTC'),
      })
      .prefault({}),
    invariants: z
      .strictObject({ no_console_errors: z.boolean().default(true), no_same_origin_5xx: z.boolean().default(true), console_allowlist: z.array(z.string().max(200)).default([]) })
      .prefault({}),
    fixtures: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,30}$/), FixtureSpec).default({}),
    mutation_endpoints: z
      .array(
        z.strictObject({
          method: z.enum(['POST', 'PUT', 'PATCH', 'DELETE']),
          path: z.string().regex(/^\/(?!\/)/).refine((p) => p.split('{owned}').length === 2, 'path must contain exactly one {owned} segment placeholder'),
        }),
      )
      .default([]),
    triage: z.strictObject({ rules: z.array(TriageRule).max(100) }).optional(),
    limits: Limits.prefault({}),
  })
  .superRefine((p, ctx) => {
    const origins = p.allowed_origins.map((o) => new URL(o).origin);
    const base = isAllowed(p.base_url, p.allowed_origins);
    if (!origins.includes(new URL(p.base_url).origin)) ctx.addIssue({ code: 'custom', path: ['allowed_origins'], message: 'must include the base_url origin' });
    if (!base.allowed) ctx.addIssue({ code: 'custom', path: ['base_url'], message: `base_url rejected: ${base.reason}` });
    p.allowed_origins.forEach((o, i) => {
      const d = isAllowed(o, [o]);
      if (!d.allowed) ctx.addIssue({ code: 'custom', path: ['allowed_origins', i], message: `origin rejected: ${d.reason}` });
    });
  });

export type SiteProfile = z.infer<typeof SiteProfileSchema>;
export type FixtureSpecT = z.infer<typeof FixtureSpec>;
export type TargetT = z.infer<typeof Target>;
export type TriageRuleT = z.infer<typeof TriageRule>;
