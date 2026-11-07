import { z } from 'zod';

export const SCHEMA_VERSION = '1';
export const VERDICTS = ['NON_ESEGUITO', 'PASS', 'FAIL', 'BLOCKED', 'SKIPPED', 'INCONCLUSIVE'] as const;
export const CASE_STATES = ['DISCOVERED', 'INFERRED', 'APPROVED', 'EXECUTABLE', 'NEEDS_SPEC'] as const;
export const TRIAGE_CLASSES = ['BUG_APP', 'ENV_DB_TIMEOUT', 'ENV_SERVICE', 'AUTH_FIXTURE', 'TEST_FLAKY', 'SPEC_GAP', 'DATA_DRIFT', 'UNKNOWN'] as const;

export const Verdict = z.enum(VERDICTS);
export const CaseState = z.enum(CASE_STATES);
export const TriageClass = z.enum(TRIAGE_CLASSES);
export const GateDecisionValue = z.enum(['PASS', 'FAIL', 'INCONCLUSIVE']);
export const GateEffect = z.enum(['FAIL', 'INCONCLUSIVE']);

export const SchemaVersion = z.literal(SCHEMA_VERSION);
export const CaseId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, 'invalid case_id');
export const SiteId = z.string().regex(/^[a-z0-9-]{1,40}$/, 'invalid site_id');
export const SecretRef = z.string().regex(/^env:[A-Z][A-Z0-9_]*$/, 'must be a secret reference like env:NAME (plaintext secrets are rejected)');
export const Iso = z.iso.datetime();
export const Sha = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export const RunId = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'run_id must be a ULID');

export type VerdictT = z.infer<typeof Verdict>;
export type CaseStateT = z.infer<typeof CaseState>;
export type TriageClassT = z.infer<typeof TriageClass>;
