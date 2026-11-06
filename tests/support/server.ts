import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface TestServer {
  origin: string;
  port: number;
  calls: { method: string; url: string; body: string }[];
  items: Map<string, string>;
  close(): Promise<void>;
}

const page = (title: string, body: string, extra = '') => `<!doctype html><html><head><title>${title}</title></head><body>${body}${extra}</body></html>`;

export async function startServer(port = 0): Promise<TestServer> {
  const calls: TestServer['calls'] = [];
  const items = new Map<string, string>();
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      calls.push({ method: req.method ?? 'GET', url: url.pathname, body });
      const send = (status: number, html: string, type = 'text/html') => { res.writeHead(status, { 'content-type': type }); res.end(html); };
      const p = url.pathname;
      if (p === '/api/items' && req.method === 'POST') {
        const name = (JSON.parse(body || '{}') as { name?: string }).name ?? '';
        const id = `id${items.size + 1}`;
        items.set(id, name);
        return send(201, JSON.stringify({ id, name }), 'application/json');
      }
      const m = /^\/api\/items\/(.+)$/.exec(p);
      if (m && req.method === 'DELETE') {
        const key = decodeURIComponent(m[1] as string);
        const found = [...items.entries()].find(([id, n]) => id === key || n === key);
        if (!found) return send(404, '{}', 'application/json');
        items.delete(found[0]);
        return send(204, '');
      }
      if (p === '/ok' || p === '/login') return send(200, page('Home', '<h1>Welcome</h1><a href="/dashboard">Dashboard</a><p>Accedi</p>'));
      if (p === '/dashboard') return send(200, page('Dashboard', '<h1>Dashboard</h1><div data-testid="row">r1</div><div data-testid="row">r2</div>'));
      if (p === '/fail') return send(200, page('Fail', '<p>nothing here</p>'));
      if (p === '/gateway-timeout') return send(504, page('Timeout', '<p>Gateway Timeout</p>'));
      if (p === '/subresource-5xx') return send(200, page('Sub', '<p>Hello</p>', '<img src="/broken.png">'));
      if (p === '/broken.png') return send(500, 'err');
      if (p === '/external') return send(200, page('Ext', '<p>Hello</p>', '<img src="http://evil.invalid/x.png"><img src="http://169.254.169.254/latest/meta-data">'));
      if (p === '/token-echo') return send(200, page('Echo', '<p>Hello</p><pre>{"session_token":"s3cr3t-OPAQUE-token-9988"} contact bob@example.com</pre>'));
      if (p === '/xss') return send(200, page('<script>alert(1)</script>', '<p>x</p>'));
      send(404, page('404', 'not found'));
    });
  });
  await new Promise<void>((r) => srv.listen(port, '127.0.0.1', r));
  const addr = srv.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${addr.port}`, port: addr.port, calls, items, close: () => new Promise((r) => srv.close(() => r())) };
}
