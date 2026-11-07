import { FrameworkError } from '../errors.js';
import { redactor } from './redactor.js';

const REF_RE = /^env:([A-Z][A-Z0-9_]*)$/;

export function parseSecretRef(ref: string): string {
  const m = REF_RE.exec(ref);
  if (!m?.[1]) throw new FrameworkError('PLAINTEXT_SECRET', 'value is not a secret reference (env:NAME)');
  return m[1];
}

export function maskRef(ref: string): string {
  return `${ref}=***`;
}

/** Resolve env:NAME and register the value with the redactor before it can reach any output. */
export function resolveSecret(ref: string, env: NodeJS.ProcessEnv = process.env): string {
  const name = parseSecretRef(ref);
  const v = env[name];
  if (v === undefined || v === '') throw new FrameworkError('SECRET_UNAVAILABLE', `environment variable ${name} is not set`);
  redactor.register(v);
  return v;
}
