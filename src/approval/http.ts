import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { approvalPage } from './page.js';

export async function startApprovalHttp(options: { token: string; state: () => unknown; decide: (input: Record<string, unknown>) => boolean; cancel: () => void; port?: number; heartbeatMs?: number;
  admin?: (path: string, input?: unknown) => unknown | Promise<unknown>;
}) {
  let origin = ''; let lastSeen = 0;
  const server = createServer(async (request, response) => {
    const security = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' };
    const send = (status: number, body: unknown) => { response.writeHead(status, { ...security, 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(body)); };
    try {
      if (request.headers.host !== new URL(origin).host) { send(403, { error: 'Forbidden host' }); return; }
      const path = request.url;
      if (path === '/' && request.method === 'GET') {
        const nonce = randomBytes(18).toString('base64');
        response.writeHead(200, { ...security, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'` });
        response.end(approvalPage(nonce)); return;
      }
      const expected = Buffer.from(`Bearer ${options.token}`); const actual = Buffer.from(request.headers.authorization ?? '');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) { send(401, { error: 'Unauthorized' }); return; }
      if (request.headers.origin && request.headers.origin !== origin) { send(403, { error: 'Forbidden origin' }); return; }
      if (path === '/api/state' && request.method === 'GET') { lastSeen = Date.now(); send(200, options.state()); return; }
      if (options.admin && request.method === 'GET' && ['/api/settings', '/api/history'].includes(path ?? '')) { send(200, await options.admin(path!)); return; }
      if (request.method !== 'POST' || !['/api/decision', '/api/cancel', ...(options.admin ? ['/api/settings', '/api/key', '/api/connection-check'] : [])].includes(path ?? '')) { send(404, { error: 'Not found' }); return; }
      if (request.headers.origin !== origin || request.headers['content-type'] !== 'application/json') { send(403, { error: 'Forbidden request' }); return; }
      let raw = ''; for await (const chunk of request) { raw += chunk; if (Buffer.byteLength(raw) > 8192) { send(413, { error: 'Too large' }); return; } }
      const input: unknown = JSON.parse(raw);
      if (!input || typeof input !== 'object' || Array.isArray(input)) { send(400, { error: 'Invalid request' }); return; }
      if (options.admin && ['/api/settings', '/api/key', '/api/connection-check'].includes(path ?? '')) { send(200, await options.admin(path!, input)); return; }
      if (path === '/api/cancel') { if (Object.keys(input).length) { send(400, { error: 'Invalid request' }); return; } options.cancel(); send(200, { ok: true }); return; }
      if (Object.keys(input).sort().join(',') !== 'actionId,nonce,outcome') { send(400, { error: 'Invalid request' }); return; }
      send(options.decide(input as Record<string, unknown>) ? 200 : 409, { message: 'Решение обработано либо устарело.' });
    } catch { if (!response.headersSent) send(400, { error: 'Invalid request' }); }
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const heartbeat = setInterval(() => { if (lastSeen && Date.now() - lastSeen > (options.heartbeatMs ?? 15000)) { lastSeen = 0; options.cancel(); } }, 1000); heartbeat.unref();
  return { origin, url: `${origin}/#token=${options.token}`, async close() { clearInterval(heartbeat); options.cancel(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
