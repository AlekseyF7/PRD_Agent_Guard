import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
export interface PanelRecord { readonly pid: number; readonly url: string; readonly workspaceRoot: string }
export function parsePanelRecord(input: unknown): PanelRecord | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return;
  const record = input as Record<string, unknown>;
  if (!Number.isSafeInteger(record.pid) || Number(record.pid) <= 0 || typeof record.url !== 'string' || typeof record.workspaceRoot !== 'string') return;
  try {
    const url = new URL(record.url);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || !/^#token=[0-9a-f]{64}$/.test(url.hash)) return;
    return Object.freeze({ pid: record.pid as number, url: url.href, workspaceRoot: record.workspaceRoot });
  } catch { return; }
}
export function discoverPanels(directory: string): PanelRecord[] {
  const result: PanelRecord[] = [];
  try {
    for (const name of readdirSync(directory)) {
      if (!/^\d+\.json$/.test(name)) continue;
      try {
        const path = join(directory, name); const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) continue;
        const record = parsePanelRecord(JSON.parse(readFileSync(path, 'utf8')));
        if (!record || name !== `${record.pid}.json`) continue;
        process.kill(record.pid, 0); result.push(record);
      } catch { /* stale or malformed record */ }
    }
  } catch { /* no running server */ }
  return result;
}
export interface UiMessage { readonly type: 'guard-request'; readonly id: number; readonly path: string; readonly body?: Record<string, unknown> }
export function parseUiMessage(input: unknown): UiMessage | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return;
  const value = input as Record<string, unknown>;
  if (value.type !== 'guard-request' || !Number.isSafeInteger(value.id) || Number(value.id) <= 0) return;
  if (Object.keys(value).some(key => !['type', 'id', 'path', 'body'].includes(key))) return;
  if (value.path === '/api/state' && !('body' in value)) return value as unknown as UiMessage;
  const body = value.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return;
  if (value.path === '/api/cancel' && Object.keys(body).length === 0) return value as unknown as UiMessage;
  if (value.path === '/api/decision') {
    const data = body as Record<string, unknown>;
    if (Object.keys(data).sort().join(',') === 'actionId,nonce,outcome' && typeof data.actionId === 'string' && typeof data.nonce === 'string' && ['deny', 'allow_once', 'allow_once_without_explanation'].includes(data.outcome as string)) return value as unknown as UiMessage;
  }
  return;
}
// The secret stays here, in extension host. The Webview never sees URL or token.
export async function panelRequest(record: PanelRecord, message: UiMessage, fetchApi: typeof fetch = globalThis.fetch): Promise<unknown> {
  const checked = parsePanelRecord(record); if (!checked || !parseUiMessage(message)) throw Error('Invalid bridge request');
  const url = new URL(checked.url); const token = url.hash.slice('#token='.length);
  const response = await fetchApi(`${url.origin}${message.path}`, {
    method: message.body === undefined ? 'GET' : 'POST', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(3000),
    headers: { Authorization: `Bearer ${token}`, Origin: url.origin, ...(message.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(message.body === undefined ? {} : { body: JSON.stringify(message.body) }),
  });
  if (!response.ok) throw Error('Panel unavailable');
  return response.json();
}
