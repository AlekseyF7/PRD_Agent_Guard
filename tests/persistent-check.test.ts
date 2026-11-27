import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const waitFor = async (condition: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 1000; i++) { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw Error('Timed out waiting for test condition');
};
test('manual client keeps one MCP/panel session across deny and allow until q', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'guard-persistent-')));
  const workspace = join(directory, 'workspace'); const records = join(directory, 'records'); mkdirSync(workspace);
  const model = createServer(async (request, response) => {
    for await (const _chunk of request) { /* controlled local API */ }
    response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Синтетическое объяснение.' } }] }));
  });
  await new Promise<void>((resolve, reject) => { model.once('error', reject); model.listen(0, '127.0.0.1', resolve); });
  const config = join(directory, 'guard.json');
  writeFileSync(config, JSON.stringify({ workspaceRoot: workspace, llm: { baseURL: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`, model: 'synthetic', timeoutMs: 3000, authMode: 'none' } }));
  const child = spawn(process.execPath, ['scripts/check-guard.mjs', config], { env: { AGENT_GUARD_STATE_DIR: records, ...(process.env.PATH ? { PATH: process.env.PATH } : {}), ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit'); let output = ''; let errors = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { errors += data; });
  try {
    await waitFor(() => output.includes('MCP подключён'));
    const record = JSON.parse(readFileSync(join(records, readdirSync(records)[0]!), 'utf8'));
    const url = new URL(record.url); const headers = { Authorization: `Bearer ${url.hash.slice(7)}`, Origin: url.origin };
    const state = async () => (await fetch(`${url.origin}/api/state`, { headers })).json();
    let first: { action: { actionId: string }; nonce: string } | undefined;
    await waitFor(async () => { first = (await state()).pending; return !!first; });
    const submit = async (pending: { action: { actionId: string }; nonce: string }, outcome: string) => {
      const response = await fetch(`${url.origin}/api/decision`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ actionId: pending.action.actionId, nonce: pending.nonce, outcome }) });
      assert.equal(response.status, 200);
    };
    await submit(first!, 'deny'); await waitFor(() => output.includes('Enter —'));
    assert.equal(child.exitCode, null); assert.equal((await state()).last.code, 'DENIED');
    child.stdin.write('\n');
    let second: { action: { actionId: string }; nonce: string } | undefined;
    await waitFor(async () => { second = (await state()).pending; return !!second; });
    assert.notEqual(first!.action.actionId, second!.action.actionId);
    await submit(second!, 'allow_once');
    await waitFor(() => output.split('Enter —').length >= 3);
    assert.equal(child.exitCode, null); assert.equal((await state()).last.status, 'completed');
    assert.equal((await state()).last.stdout.trim(), 'guard-check');
    child.stdin.write('q\n'); const [exitCode] = await exited; assert.equal(exitCode, 0); assert.equal(errors, '');
  } finally {
    if (child.exitCode === null) { child.kill('SIGTERM'); await exited; }
    model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve())); rmSync(directory, { recursive: true, force: true });
  }
});
