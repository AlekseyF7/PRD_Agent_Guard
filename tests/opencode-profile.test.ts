import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { selectPanelRecord, type PanelRecord } from '../extensions/vscode/src/connection.js';

const record = (pid: number, root = '/project'): PanelRecord => ({ pid, workspaceRoot: root, url: `http://127.0.0.1:${10000 + pid}/#token=${'a'.repeat(64)}` });
const identity = (path: string) => path;
test('automatic selection leaves an idle previous server for the unique pending request', async () => {
  const idle = record(1); const pending = record(2);
  const selected = await selectPanelRecord([idle, pending], ['/project'], identity, idle, false,
    async current => current.pid === 2 ? { active: {}, pending: {} } : {});
  assert.equal(selected, pending);
});
test('explicit selection is retained, while missing explicit server allows discovery', async () => {
  const idle = record(1); const pending = record(2);
  const state = async () => ({ pending: {} });
  assert.equal(await selectPanelRecord([idle, pending], [], identity, idle, true, state), idle);
  assert.equal(await selectPanelRecord([pending], [], identity, idle, true, state), pending);
});
test('ambiguous pending servers require selection and another workspace does not steal focus', async () => {
  const a = record(1); const b = record(2); const external = record(3, '/other');
  assert.equal(await selectPanelRecord([a, b], [], identity, undefined, false, async () => ({ pending: {} })), undefined);
  assert.equal(await selectPanelRecord([a, external], ['/project'], identity, undefined, false,
    async current => current === external ? { pending: {} } : {}), a);
});
test('unavailable server is skipped and current running attempt is retained', async () => {
  const a = record(1); const b = record(2);
  assert.equal(await selectPanelRecord([a, b], [], identity, undefined, false, async current => {
    if (current === a) throw Error('offline'); return { pending: {} };
  }), b);
  assert.equal(await selectPanelRecord([a, b], [], identity, a, false,
    async current => current === a ? { active: {} } : { pending: {} }), a);
});

test('profile generator preserves existing files and rejects workspace mismatch without exposing configuration', t => {
  const folder = mkdtempSync(join(tmpdir(), 'guard-profile-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const configPath = join(folder, 'guard.json');
  const config = { workspaceRoot: folder, llm: { baseURL: 'https://example.invalid/v1', model: 'synthetic', timeoutMs: 1000, authMode: 'none' } };
  writeFileSync(configPath, JSON.stringify(config));
  const run = () => spawnSync(process.execPath, ['scripts/setup-opencode.mjs', folder, configPath], { encoding: 'utf8' });
  assert.equal(run().status, 0);
  const contents = readFileSync(join(folder, 'opencode.json'), 'utf8');
  const instructions = readFileSync(join(folder, 'AGENTS.md'), 'utf8');
  const profile = JSON.parse(contents);
  assert.equal(profile.mcp.servers.guard.command[0], process.execPath);
  assert.ok(!contents.includes('apiKey'));
  assert.equal(run().status, 1);
  assert.equal(readFileSync(join(folder, 'opencode.json'), 'utf8'), contents);
  assert.equal(readFileSync(join(folder, 'AGENTS.md'), 'utf8'), instructions);
  rmSync(join(folder, 'opencode.json')); rmSync(join(folder, 'AGENTS.md'));
  writeFileSync(configPath, JSON.stringify({ ...config, workspaceRoot: tmpdir() }));
  assert.equal(run().status, 1);
  assert.throws(() => readFileSync(join(folder, 'opencode.json')));
});
