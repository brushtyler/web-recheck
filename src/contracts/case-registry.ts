import { z } from 'zod';
import { CaseId, CaseState, Iso, SchemaVersion, SecretRef, Sha, SiteId } from './common.js';
import { Target } from './site-profile.js';

const RelPath = z.string().regex(/^\/(?!\/)[^\s]*$/, 'path must be relative and start with a single /').max(500);
const Str = z.string().max(500);

export const Action = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('navigate'), path: RelPath }),
  z.strictObject({ type: z.literal('click'), target: Target }),
  z.strictObject({ type: z.literal('fill'), target: Target, value: Str.optional(), value_ref: SecretRef.optional() }),
  z.strictObject({ type: z.literal('select'), target: Target, option: Str }),
  z.strictObject({ type: z.literal('press'), key: z.string().max(30) }),
  z.strictObject({ type: z.literal('wait_for'), text: Str.optional(), target: Target.optional(), timeout_ms: z.number().int().min(100).max(120000).default(5000) }),
  z.strictObject({ type: z.literal('fixture'), kind: z.string().regex(/^[a-z][a-z0-9_]{0,30}$/), as: z.string().regex(/^[a-z][a-z0-9_]{0,30}$/) }),
]);

export const Oracle = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('text_visible'), text: Str }),
  z.strictObject({ type: z.literal('element_present'), target: Target }),
  z.strictObject({ type: z.literal('url_matches'), path: RelPath.optional(), contains: Str.optional() }),
  z.strictObject({ type: z.literal('http_status'), status: z.number().int().min(100).max(599), url_contains: Str.optional() }),
  z.strictObject({ type: z.literal('no_console_errors') }),
  z.strictObject({ type: z.literal('count_equals'), target: Target, count: z.number().int().min(0) }),
]);

const Scalar = z.union([z.string(), z.number(), z.boolean()]);

export const Case = z
  .strictObject({
    case_id: CaseId,
    title: z.string().min(1).max(200),
    state: CaseState,
    case_revision: z.number().int().min(1),
    content_hash: Sha,
    mutating: z.boolean().default(false),
    parameters: z.record(z.string(), Scalar).default({}),
    steps: z.array(Action).max(100),
    oracles: z.array(Oracle).min(1, 'at least one oracle is required').max(50),
    approval: z
      .strictObject({ approved_by: z.string().min(1).max(100), approved_at: Iso, approved_revision: z.number().int().min(1), approved_content_hash: Sha })
      .optional(),
    source: z.strictObject({ inventory_id: z.string().max(100).optional() }).optional(),
  })
  .superRefine((c, ctx) => {
    c.steps.forEach((s, i) => {
      if (s.type === 'fill') {
        if ((s.value === undefined) === (s.value_ref === undefined)) ctx.addIssue({ code: 'custom', path: ['steps', i], message: 'fill needs exactly one of value, value_ref' });
        if (s.value !== undefined && /pass(word)?|secret|token/i.test(`${s.target.name ?? ''}${s.target.test_id ?? ''}`)) {
          ctx.addIssue({ code: 'custom', path: ['steps', i, 'value'], message: 'sensitive field must use value_ref (env:NAME)' });
        }
      }
      if (s.type === 'wait_for' && (s.text === undefined) === (s.target === undefined)) ctx.addIssue({ code: 'custom', path: ['steps', i], message: 'wait_for needs exactly one of text, target' });
    });
    c.oracles.forEach((o, i) => {
      if (o.type === 'url_matches' && (o.path === undefined) === (o.contains === undefined)) ctx.addIssue({ code: 'custom', path: ['oracles', i], message: 'url_matches needs exactly one of path, contains' });
    });
  });

export const CaseRegistrySchema = z.strictObject({ schema_version: SchemaVersion, site_id: SiteId, cases: z.array(Case) });

export type CaseT = z.infer<typeof Case>;
export type CaseRegistry = z.infer<typeof CaseRegistrySchema>;
export type ActionT = z.infer<typeof Action>;
export type OracleT = z.infer<typeof Oracle>;
