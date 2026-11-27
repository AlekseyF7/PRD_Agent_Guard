import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtempSync, mkdirSync, realpathSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../src/mcp/runtime.js';
import { createSettingsStore, type UserSettings } from '../src/mcp/settings.js';
import { createExecutionService } from '../src/execution/service.js';
import { createCore, DEFAULT_POLICIES } from '../src/core/index.js';
import { parseUiMessage } from '../extensions/vscode/src/connection.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'guard-settings-')));
after(() => rmSync(root, { recursive: true, force: true }));
const config = { workspaceRoot: root, llm: { baseURL: 'https://example.invalid/v1', model: 'synthetic', timeoutMs: 1000, authMode: 'none' } };
const goodFetch: typeof fetch = async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Синтетическое объяснение.' } }] }));
type Runtime = Awaited<ReturnType<typeof createRuntime>>;
function api(runtime: Runtime) {
  const url = new URL(runtime.panel.url);
  return async (path: string, body?: unknown) => fetch(url.origin + path, { method: body === undefined ? 'GET' : 'POST', headers: {
    Authorization: `Bearer ${url.hash.slice(7)}`, Origin: url.origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function metadata(runtime: Runtime) { return await (await api(runtime)('/api/settings')).json() as { configured: boolean; hasKey: boolean; settings: UserSettings }; }
async function pending(runtime: Runtime) {
  for (let i = 0; i < 100; i++) {
    const state = await (await api(runtime)('/api/state')).json();
    if (state.pending) return state.pending as { action: { actionId: string }; nonce: string };
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw Error('No pending attempt');
}
const command = process.platform === 'win32' ? "Write-Output 'synthetic'" : "printf 'synthetic'";

test('valid policies persist atomically, cancel pending and block before explanation; invalid settings preserve pending', async () => {
  const folder = join(root, 'settings-store');
  const store = createSettingsStore(root, folder);
  let requests = 0;
  const runtime = await createRuntime(config, { fetch: async (...args) => { requests++; return goodFetch(...args); } }, store);
  try {
    const call = runtime.service.run({ command, cwd: root });
    const first = await pending(runtime);
    const meta = await metadata(runtime);
    assert.equal((await api(runtime)('/api/settings', { settings: { ...meta.settings, policies: { ...meta.settings.policies, file_delete: 'allow' } } })).status, 400);
    assert.equal((await pending(runtime)).action.actionId, first.action.actionId);
    const settings = { ...meta.settings, policies: { ...meta.settings.policies, file_delete: 'block' } };
    assert.equal((await api(runtime)('/api/settings', { settings })).status, 200);
    assert.equal((await call).status, 'not_executed');
    assert.equal((await api(runtime)('/api/decision', { actionId: first.action.actionId, nonce: first.nonce, outcome: 'allow_once' })).status, 409);
    const result = await runtime.service.run({ command: process.platform === 'win32' ? 'Remove-Item sample.txt' : 'rm -- sample.txt', cwd: root });
    assert.equal(result.status === 'not_executed' && result.code, 'POLICY_BLOCK');
    assert.equal(requests, 1);
    assert.deepEqual(store.load(), settings);
    assert.equal(readdirSync(folder).length, 1);
    const restarted = await createRuntime(config, { fetch: goodFetch }, store);
    try { assert.equal((await metadata(restarted)).settings.policies.file_delete, 'block'); }
    finally { await restarted.close(); }
  } finally { await runtime.close(); }
});

test('write failure preserves current policies and pending consent', async () => {
  const runtime = await createRuntime(config, { fetch: goodFetch }, { load: () => undefined, save() { throw Error('disk full'); } });
  try {
    const call = runtime.service.run({ command, cwd: root });
    const card = await pending(runtime);
    const meta = await metadata(runtime);
    assert.equal((await api(runtime)('/api/settings', { settings: { ...meta.settings, policies: { ...meta.settings.policies, file_delete: 'block' } } })).status, 400);
    assert.equal((await pending(runtime)).action.actionId, card.action.actionId);
    assert.deepEqual((await metadata(runtime)).settings, meta.settings);
    runtime.service.cancel(); await call;
  } finally { await runtime.close(); }
});

test('stored key is delivered only in memory, connection check does not execute or approve, address reuse is explicit', async () => {
  const folder = join(root, 'key-store');
  const store = createSettingsStore(root, folder);
  const headers: Headers[] = [];
  const runtime = await createRuntime(config, { fetch: async (_url, init) => { headers.push(new Headers(init?.headers)); return goodFetch(_url, init); } }, store);
  const key = 'synthetic-private-key'; const reference = 'vscode:11111111-1111-4111-8111-111111111111';
  let saved: UserSettings;
  try {
    const meta = await metadata(runtime);
    saved = { ...meta.settings, llm: { ...meta.settings.llm, authMode: 'apiKey', credentialRef: reference } };
    assert.equal((await api(runtime)('/api/settings', { settings: saved })).status, 200);
    const waiting = runtime.service.run({ command, cwd: root });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await api(runtime)('/api/state').then(r => r.json())).credentialNeeded, reference);
    assert.equal((await api(runtime)('/api/key', { credentialRef: reference, key })).status, 200);
    const card = await pending(runtime);
    assert.equal((await api(runtime)('/api/connection-check', {})).status, 200);
    assert.equal((await pending(runtime)).action.actionId, card.action.actionId);
    assert.equal(runtime.service.history().length, 0);
    assert.ok(headers.every(h => h.get('Authorization') === `Bearer ${key}`));
    const settingsText = readFileSync(join(folder, readdirSync(folder)[0]!), 'utf8');
    assert.ok(!settingsText.includes(key));
    assert.ok(!JSON.stringify(await metadata(runtime)).includes(key));
    assert.equal((await api(runtime)('/api/settings', { settings: { ...saved, llm: { ...saved.llm, model: key } } })).status, 400);
    const newAddress = { ...saved, llm: { ...saved.llm, baseURL: 'https://another.invalid/v1' } };
    assert.equal((await api(runtime)('/api/settings', { settings: newAddress })).status, 400);
    assert.equal((await pending(runtime)).action.actionId, card.action.actionId);
    assert.equal((await api(runtime)('/api/settings', { settings: newAddress, confirmKeyReuse: true })).status, 200);
    await waiting;
    assert.equal((await api(runtime)('/api/key', { credentialRef: reference })).status, 200);
    const missing = await (await api(runtime)('/api/connection-check', {})).json();
    assert.equal(missing.code, 'MISSING_API_KEY');
    const none = { ...saved, llm: { baseURL: 'http://127.0.0.1:1234/v1', model: 'local', timeoutMs: 1000, authMode: 'none' } };
    assert.equal((await api(runtime)('/api/settings', { settings: none })).status, 200);
    await api(runtime)('/api/connection-check', {});
    assert.equal(headers.at(-1)!.has('Authorization'), false);
  } finally { await runtime.close(); }
  const restarted = await createRuntime(config, { fetch: goodFetch }, store);
  try { assert.equal((await metadata(restarted)).hasKey, false); } finally { await restarted.close(); }
});

test('administrative endpoints require authentication and are not exposed through Webview RPC', async () => {
  const runtime = await createRuntime(config);
  try {
    for (const path of ['/api/settings', '/api/key', '/api/connection-check', '/api/history']) {
      assert.equal((await fetch(new URL(runtime.panel.url).origin + path)).status, 401);
      if (path !== '/api/history') assert.equal(parseUiMessage({ type: 'guard-request', id: 1, path, body: {} }), undefined);
    }
    assert.equal((await api(runtime)('/api/settings', { settings: { ...(await metadata(runtime)).settings, apiKey: 'not-allowed' } })).status, 400);
  } finally { await runtime.close(); }
});

test('session history is bounded, includes block/deny/cancel, skips BUSY, and cannot authorize old actions', async () => {
  const core = createCore({ workspaceRoot: root, mode: 'paranoid', policies: DEFAULT_POLICIES });
  let launches = 0;
  const service = createExecutionService({ check: core.check, explain: async action => ({ actionId: action.actionId, status: 'available', text: 'synthetic' }),
    approve: async ({ action }) => ({ actionId: action.actionId, outcome: 'deny' }), shell: 'posix-sh', approvalTimeoutMs: 1000,
    execute: async () => { launches++; throw Error('must not execute'); } });
  for (let i = 0; i < 55; i++) await service.run({ command: `echo synthetic-${i}`, cwd: root });
  assert.equal(service.history().length, 50);
  assert.equal(service.history()[0]!.command, 'echo synthetic-5');
  assert.equal(service.state().historyVersion, 55);
  assert.ok(Object.isFrozen(service.history()));
  assert.equal(launches, 0);
  const runtime = await createRuntime(config, { fetch: goodFetch });
  try {
    const call = runtime.service.run({ command, cwd: root });
    await pending(runtime);
    const busy = await runtime.service.run({ command, cwd: root });
    assert.equal(busy.status === 'not_executed' && busy.code, 'BUSY');
    runtime.service.cancel(); await call;
    assert.equal(runtime.service.history().length, 1);
    assert.equal((await (await api(runtime)('/api/history')).json()).length, 1);
  } finally { await runtime.close(); }
  const fresh = await createRuntime(config);
  try { assert.equal(fresh.service.history().length, 0); } finally { await fresh.close(); }
});

test('saved credential reference survives restart while key must be hydrated again', async () => {
  const store = createSettingsStore(root, join(root, 'restart-store'));
  const reference = 'vscode:22222222-2222-4222-8222-222222222222';
  const first = await createRuntime(config, { fetch: goodFetch }, store);
  const settings = (await metadata(first)).settings;
  await api(first)('/api/settings', { settings: { ...settings, llm: { ...settings.llm, authMode: 'apiKey', credentialRef: reference } } });
  await api(first)('/api/key', { credentialRef: reference, key: 'synthetic-restart-secret' });
  await first.close();
  let header: string | null = null;
  const second = await createRuntime(config, { fetch: async (_url, init) => { header = new Headers(init?.headers).get('Authorization'); return goodFetch(_url, init); } }, store);
  try {
    assert.equal((await metadata(second)).hasKey, false);
    assert.equal((await (await api(second)('/api/state')).json()).credentialNeeded, reference);
    await api(second)('/api/key', { credentialRef: reference, key: 'synthetic-restart-secret' });
    const result = await (await api(second)('/api/connection-check', {})).json();
    assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(header, 'Bearer synthetic-restart-secret');
    assert.equal(second.service.history().length, 0);
  } finally { await second.close(); }
});

test('history clips long output and records one-time decision without rerunning it', async () => {
  let launches = 0;
  const core = createCore({ workspaceRoot: root, mode: 'paranoid', policies: DEFAULT_POLICIES });
  const service = createExecutionService({ check: core.check, explain: async action => ({ actionId: action.actionId, status: 'available', text: 'x'.repeat(5000) }),
    approve: async ({ action }) => ({ actionId: action.actionId, outcome: 'allow_once' }), shell: 'posix-sh', approvalTimeoutMs: 1000,
    execute: async () => { launches++; return { status: 'completed', exitCode: 0, stdout: 'x'.repeat(9000), stderr: '', stdoutTruncated: false, stderrTruncated: false }; } });
  await service.run({ command, cwd: root });
  const entry = service.history()[0]!;
  assert.equal(entry.shortened, true); assert.equal(entry.explanation!.length, 4096);
  assert.equal(entry.decision, 'allow_once');
  assert.equal(entry.result.status !== 'not_executed' && entry.result.stdout.length, 4096);
  service.history(); assert.equal(launches, 1);
});

test('settings cannot interrupt an already executing process', async () => {
  const runtime = await createRuntime(config, { fetch: goodFetch });
  const reference = 'vscode:33333333-3333-4333-8333-333333333333';
  const initial = (await metadata(runtime)).settings;
  await api(runtime)('/api/settings', { settings: { ...initial, llm: { ...initial.llm, authMode: 'apiKey', credentialRef: reference } } });
  await api(runtime)('/api/key', { credentialRef: reference, key: 'synthetic-executing-secret' });
  let finish!: () => void;
  const core = createCore({ workspaceRoot: root, mode: 'paranoid', policies: DEFAULT_POLICIES });
  runtime.service.replace({ check: core.check, explain: async action => ({ actionId: action.actionId, status: 'available', text: 'synthetic' }),
    approve: async ({ action }) => ({ actionId: action.actionId, outcome: 'allow_once' }), shell: 'posix-sh', approvalTimeoutMs: 1000,
    execute: async () => { await new Promise<void>(resolve => { finish = resolve; }); return { status: 'completed', exitCode: 0, stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false }; } });
  try {
    const call = runtime.service.run({ command, cwd: root });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(runtime.service.state().active?.phase, 'executing');
    const meta = await metadata(runtime);
    assert.equal((await api(runtime)('/api/settings', { settings: meta.settings })).status, 400);
    assert.equal((await api(runtime)('/api/key', { credentialRef: reference })).status, 400);
    assert.equal((await metadata(runtime)).hasKey, true);
    assert.equal(runtime.service.state().active?.phase, 'executing');
    finish(); await call;
  } finally { finish?.(); await runtime.close(); }
});
