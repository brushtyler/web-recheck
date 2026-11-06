import { FrameworkError } from '../errors.js';

export interface RedactorLike {
  redact(text: string): string;
  containsSecret(text: string): boolean;
}

const HEADER_RE = /\b(authorization|proxy-authorization|cookie|set-cookie)(["']?\s*[:=]\s*["']?)([^"'\r\n]*)/gi;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{4,}/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
const KV_SOURCE = '((?:password|passwd|pwd|secret|token|api[_-]?key|session(?:[_-]?id)?|csrf)[A-Za-z0-9_-]*(?:\\\\?["\'])?\\s*[:=]\\s*(?:\\\\?["\'])?)([^"\'&\\s,;}\\]\\[{<>\\\\]+)';
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const PHONE_RE = /(?<![\w.:-])(?:\+\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]\d{3,4}[\s.-]\d{3,4}(?![\w-])|\+\d{8,15}\b/g;

export class Redactor implements RedactorLike {
  private secrets = new Set<string>();
  private forms: string[] = [];

  /** Register a secret value; its raw, URL-encoded and base64 forms are scrubbed verbatim everywhere. */
  register(secret: string): void {
    if (!secret || secret.length < 3 || secret.startsWith('[REDACTED') || this.secrets.has(secret)) return;
    this.secrets.add(secret);
    const forms = new Set([secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64')]);
    this.forms = [...new Set([...this.forms, ...forms])].sort((a, b) => b.length - a.length);
  }

  reset(): void {
    this.secrets.clear();
    this.forms = [];
  }

  /** Runtime credential discovery: values of token-like keys found in captured text become exact secrets. */
  discover(text: string): void {
    const re = new RegExp(KV_SOURCE, 'gi');
    for (const m of text.matchAll(re)) {
      const v = m[2];
      if (v && v.length >= 8) this.register(v);
    }
  }

  redact(text: string): string {
    try {
      this.discover(text);
      let out = text
        .replace(HEADER_RE, (_m, k: string, sep: string) => `${k}${sep}[REDACTED:header]`)
        .replace(BEARER_RE, 'Bearer [REDACTED:bearer]')
        .replace(JWT_RE, '[REDACTED:jwt]')
        .replace(new RegExp(KV_SOURCE, 'gi'), (_m, k: string) => `${k}[REDACTED:secret]`)
        .replace(EMAIL_RE, '[REDACTED:email]')
        .replace(PHONE_RE, '[REDACTED:phone]');
      for (const f of this.forms) if (out.includes(f)) out = out.split(f).join('[REDACTED:secret]');
      return out;
    } catch (e) {
      throw new FrameworkError('REDACTION_FAILURE', `redaction failed: ${(e as Error).name}`);
    }
  }

  containsSecret(text: string): boolean {
    return this.forms.some((f) => text.includes(f));
  }
}

export const redactor = new Redactor();
