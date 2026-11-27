import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createRuntime } from '../src/mcp/runtime.js';

const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'guard-mcp-')));
const workspace = join(sandbox, 'workspace'); mkdirSync(workspace);
after(() => rmSync(sandbox, { recursive: true, force: true }));
const config = { workspaceRoot: workspace, llm: { baseURL: 'http://127.0.0.1:1/v1', model: 'fake-model', timeoutMs: 1000, authMode: 'none' } };
const fakeFetch: typeof fetch = async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Синтетическое объяснение, не реальная модель.' } }] }));
function auth(url: string) { const value = new URL(url); return { origin: value.origin, headers: { Authorization: `Bearer ${new URLSearchParams(value.hash.slice(1)).get('token')}` } }; }
async function state(url: string) { const api = auth(url); const r = await fetch(`${api.origin}/api/state`, { headers: api.headers }); assert.equal(r.status, 200); return r.json(); }
async function untilPending(url: string) {
  for (let i = 0; i < 200; i++) { const view = await state(url); if (view.pending) return view.pending; await new Promise(r => setTimeout(r, 10)); }
  throw Error('No pending card');
}
async function decide(url: string, pending: { action: { actionId: string }; nonce: string }, outcome: string) {
  const api = auth(url);
  return fetch(`${api.origin}/api/decision`, { method: 'POST', headers: { ...api.headers, Origin: api.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ actionId: pending.action.actionId, nonce: pending.nonce, outcome }) });
}
async function linked(runtime: Awaited<ReturnType<typeof createRuntime>>) {
  const pair = InMemoryTransport.createLinkedPair(); const client = new Client({ name: 'guard-test-client', version: '1' });
  await runtime.server.connect(pair[0]); await client.connect(pair[1]); return client;
}
const deletion = process.platform === 'win32' ? 'Remove-Item -LiteralPath sample.txt' : 'rm -- sample.txt';

test('HTTP UI requires session secret and validates Origin/Host', async () => {
  const runtime = await createRuntime(config, { fetch: fakeFetch }); const api = auth(runtime.panel.url);
  try {
    assert.equal((await fetch(`${api.origin}/api/state`)).status, 401);
    assert.equal((await fetch(`${api.origin}/api/state`, { headers: { ...api.headers, Origin: 'https://foreign.invalid' } })).status, 403);
    const foreignHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const call = httpRequest(`${api.origin}/api/state`, { headers: { ...api.headers, Host: 'foreign.invalid' } }, response => { response.resume(); resolve(response.statusCode); });
      call.once('error', reject); call.end();
    });
    assert.equal(foreignHostStatus, 403);
    assert.equal((await fetch(`${api.origin}/api/cancel`, { method: 'POST', headers: { ...api.headers, 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    const page = await fetch(`${api.origin}/`); assert.equal(page.status, 200);
    assert.ok(page.headers.get('content-security-policy')?.includes("frame-ancestors 'none'"));
    assert.ok(!(await page.text()).includes(new URLSearchParams(new URL(runtime.panel.url).hash.slice(1)).get('token')!));
  } finally { await runtime.close(); }
});
test('MCP lists only the guarded tool; unknown approved input is rejected', async () => {
  const runtime = await createRuntime(config, { fetch: fakeFetch }); const client = await linked(runtime);
  try {
    assert.deepEqual((await client.listTools()).tools.map(t => t.name), ['guard_execute_command']);
    const bad = await client.callTool({ name: 'guard_execute_command', arguments: { command: 'echo test', cwd: workspace, approved: true } });
    assert.equal(bad.isError, true); assert.equal(runtime.service.state().active, undefined);
  } finally { await client.close(); await runtime.close(); }
});
test('MCP + UI + real safe execution: deny preserves file, fresh approval removes it once', async () => {
  const runtime = await createRuntime(config, { fetch: fakeFetch }); const client = await linked(runtime);
  const path = join(workspace, 'sample.txt'); writeFileSync(path, 'synthetic');
  try {
    const denied = client.callTool({ name: 'guard_execute_command', arguments: { command: deletion, cwd: workspace } });
    const first = await untilPending(runtime.panel.url); assert.equal(existsSync(path), true);
    assert.equal((await decide(runtime.panel.url, first, 'deny')).status, 200);
    const deniedResult = await denied; assert.equal(deniedResult.isError, true); assert.equal(existsSync(path), true);
    const allowed = client.callTool({ name: 'guard_execute_command', arguments: { command: deletion, cwd: workspace } });
    const second = await untilPending(runtime.panel.url); assert.notEqual(first.action.actionId, second.action.actionId);
    assert.equal((await decide(runtime.panel.url, first, 'allow_once')).status, 409);
    assert.equal((await decide(runtime.panel.url, second, 'allow_once')).status, 200);
    assert.equal((await decide(runtime.panel.url, second, 'allow_once')).status, 409);
    const result = await allowed; assert.equal(result.isError, false); assert.equal(existsSync(path), false);
    assert.ok(!JSON.stringify(result).includes(new URLSearchParams(new URL(runtime.panel.url).hash.slice(1)).get('token')!));
  } finally { await client.close(); await runtime.close(); }
});
test('unavailable explanation rejects ordinary allow but accepts explicit degraded decision', async () => {
  const runtime = await createRuntime(config, { fetch: async () => new Response('private error', { status: 500 }) });
  try {
    const call = runtime.service.run({ command: process.platform === 'win32' ? 'Write-Output synthetic' : 'printf synthetic', cwd: workspace });
    const pending = await untilPending(runtime.panel.url); assert.equal(pending.explanation.status, 'unavailable');
    assert.equal((await decide(runtime.panel.url, pending, 'allow_once')).status, 409);
    assert.equal((await decide(runtime.panel.url, pending, 'allow_once_without_explanation')).status, 200);
    assert.equal((await call).status, 'completed');
  } finally { await runtime.close(); }
});
test('full stdio process uses only MCP stdout and private panel record; controlled API, no cloud keys', async () => {
  const model = createServer(async (request, response) => { for await (const _chunk of request) { /* consume synthetic request */ } response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Тестовое объяснение.' } }] })); });
  await new Promise<void>((resolve, reject) => { model.once('error', reject); model.listen(0, '127.0.0.1', resolve); });
  const stateDirectory = join(sandbox, 'private-state'); const path = join(sandbox, 'config.json');
  writeFileSync(path, '\uFEFF' + JSON.stringify({ ...config, llm: { ...config.llm, baseURL: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1` } }));
  const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/src/mcp/main.js', path], env: { AGENT_GUARD_STATE_DIR: stateDirectory }, stderr: 'pipe' });
  let stderr = ''; transport.stderr?.on('data', chunk => { stderr += chunk; });
  const client = new Client({ name: 'stdio-test', version: '1' });
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 1);
    const record = JSON.parse(readFileSync(join(stateDirectory, readdirSync(stateDirectory)[0]!), 'utf8'));
    const call = client.callTool({ name: 'guard_execute_command', arguments: { command: process.platform === 'win32' ? 'Write-Output synthetic' : 'printf synthetic', cwd: workspace } });
    const pending = await untilPending(record.url); assert.equal((await decide(record.url, pending, 'allow_once')).status, 200);
    const result = await call; assert.equal(result.isError, false);
    assert.equal(stderr, ''); assert.ok(!JSON.stringify(result).includes(record.url));
  } finally { await client.close(); model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve())); }
});

test('known panel secret is redacted from an approved process result', async () => {
  const runtime = await createRuntime(config, { fetch: fakeFetch });
  const secret = new URLSearchParams(new URL(runtime.panel.url).hash.slice(1)).get('token')!;
  writeFileSync(join(workspace, 'private-fixture.txt'), secret);
  try {
    const command = process.platform === 'win32' ? 'Get-Content -Raw -LiteralPath private-fixture.txt' : 'cat private-fixture.txt';
    const pending = runtime.service.run({ command, cwd: workspace });
    const card = await untilPending(runtime.panel.url);
    await decide(runtime.panel.url, card, 'allow_once');
    const result = await pending;
    assert.equal(result.status, 'completed');
    assert.ok(!JSON.stringify(result).includes(secret));
    assert.ok(JSON.stringify(result).includes('[REDACTED]'));
  } finally { await runtime.close(); }
});
