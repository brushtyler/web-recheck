import { FrameworkError } from '../errors.js';

const DENIED_HOSTS = new Set(['metadata.google.internal', 'metadata', 'instance-data', '100.100.100.200', '0.0.0.0', 'metadata.azure.internal']);

export function isDeniedIp(ip: string): boolean {
  const v = ip.replace(/^\[|\]$/g, '').toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  const addr = mapped?.[1] ?? v;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(addr);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 169 && b === 254) return true;
    if (a === 0) return true;
    return addr === '100.100.100.200';
  }
  return v.startsWith('fd00:ec2:') || v === '::';
}

export function isDeniedHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return DENIED_HOSTS.has(h) || isDeniedIp(h);
}

export interface ScopeDecision {
  allowed: boolean;
  reason?: string;
}

export function isAllowed(rawUrl: string, allowedOrigins: readonly string[]): ScopeDecision {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: 'invalid URL' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { allowed: false, reason: `scheme ${u.protocol} denied` };
  if (isDeniedHost(u.hostname)) return { allowed: false, reason: 'denied host (metadata/link-local)' };
  const origins = new Set(allowedOrigins.map((o) => new URL(o).origin));
  if (!origins.has(u.origin)) return { allowed: false, reason: `origin ${u.origin} not in allowed_origins` };
  return { allowed: true };
}

export function assertBaseUrlAllowed(baseUrl: string, allowedOrigins: readonly string[]): void {
  const d = isAllowed(baseUrl, allowedOrigins);
  if (!d.allowed) throw new FrameworkError('SCOPE_DENIED', `base_url rejected: ${d.reason}`, '/base_url');
}
