import { lookup as dnsLookup } from 'node:dns';
import { isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { FrameworkError } from '../errors.js';
import { isAllowed, isDeniedIp } from './scope.js';

export interface HttpRequest {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}
export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}
export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>;
}

const MAX_BODY = 1024 * 1024;

/**
 * Preventive egress client for every non-browser network call (fixtures, reaper, lite adapter).
 * The destination is validated BEFORE connecting; DNS answers are validated and pinned through a
 * custom `lookup`, so the connection cannot be rebound to a denied address. Redirects are never followed.
 */
export function createGuardedClient(allowedOrigins: readonly string[]): HttpClient {
  return {
    request(req) {
      const decision = isAllowed(req.url, allowedOrigins);
      if (!decision.allowed) return Promise.reject(new FrameworkError('SCOPE_DENIED', `request denied: ${decision.reason}`));
      const u = new URL(req.url);
      const mod = u.protocol === 'https:' ? https : http;
      return new Promise<HttpResponse>((resolve, reject) => {
        const r = mod.request(
          u,
          {
            method: req.method,
            headers: req.headers,
            signal: req.signal,
            timeout: req.timeoutMs ?? 15000,
            lookup: (host, opts, cb) => {
              const report = (list: { address: string; family: number }[]) => {
                if (opts.all) (cb as (e: null, a: typeof list) => void)(null, list);
                else {
                  const first = list[0] as { address: string; family: number };
                  (cb as (e: null, a: string, f: number) => void)(null, first.address, first.family);
                }
              };
              if (isIP(host)) return report([{ address: host, family: isIP(host) }]);
              dnsLookup(host, { ...opts, all: true }, (err, addrs) => {
                if (err) return (cb as (e: Error) => void)(err);
                const list = addrs as unknown as { address: string; family: number }[];
                const bad = list.find((a) => isDeniedIp(a.address));
                if (bad || list.length === 0) return (cb as (e: Error) => void)(new FrameworkError('SCOPE_DENIED', 'resolved address denied'));
                report(list);
              });
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            let size = 0;
            res.on('data', (c: Buffer) => {
              size += c.length;
              if (size > MAX_BODY) {
                res.destroy(new FrameworkError('CAP_EXCEEDED', 'response too large'));
                return;
              }
              chunks.push(c);
            });
            res.on('error', reject);
            res.on('end', () => {
              const headers: Record<string, string> = {};
              for (const [k, v] of Object.entries(res.headers)) headers[k] = Array.isArray(v) ? v.join(', ') : (v ?? '');
              resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks).toString('utf8') });
            });
          },
        );
        r.on('timeout', () => r.destroy(new Error('request timeout')));
        r.on('error', reject);
        if (req.body !== undefined) r.write(req.body);
        r.end();
      });
    },
  };
}
