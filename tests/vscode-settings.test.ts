import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

type Pick = string | undefined;
async function fixture(t: { after(callback: () => void): void }, options: { picks: Pick[]; inputs?: string[]; storeFailure?: boolean; saveFailure?: boolean; hydrate?: boolean }) {
  const folder = mkdtempSync(join(tmpdir(), 'guard-settings-vscode-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const reference = 'vscode:11111111-1111-4111-8111-111111111111';
  const key = 'synthetic-old-private-key'; const newKey = 'synthetic-new-private-key';
  const values = new Map([[`agent-guard:${reference}`, key]]);
  const requests: { path: string; body?: Record<string, unknown> }[] = [];
  const forms: Record<string, unknown>[] = []; const errors: string[] = [];
  const picks = [...options.picks]; const inputs = [...(options.inputs ?? [])];
  let meta = { configured: true, hasKey: true, settings: { policies: { file_delete: 'ask', git_destructive: 'block', git_force_push: 'block', outside_workspace: 'block' },
    llm: { baseURL: 'https://old.invalid/v1', model: 'synthetic', timeoutMs: 1000, authMode: 'apiKey', credentialRef: reference } } };
  writeFileSync(join(folder, `${process.pid}.json`), JSON.stringify({ pid: process.pid, workspaceRoot: folder, url: `http://127.0.0.1:1234/#token=${'d'.repeat(64)}` }));
  const commands = new Map<string, () => Promise<void>>();
  const subscriptions: { dispose?(): void }[] = [];
  const mock = {
    StatusBarAlignment: { Right: 1 }, ViewColumn: { Beside: 2 }, ProgressLocation: { Notification: 15 },
    workspace: { workspaceFolders: [{ uri: { fsPath: folder } }], getConfiguration: () => ({ get: () => true }) },
    commands: { registerCommand(name: string, callback: () => Promise<void>) { commands.set(name, callback); return { dispose() {} }; } },
    window: {
      createStatusBarItem: () => ({ show() {}, dispose() {} }),
      showInformationMessage() {}, showWarningMessage() {}, showErrorMessage(message: string) { errors.push(message); },
      showQuickPick: async (items: (string | { value?: string; label: string })[]) => {
        const next = picks.shift();
        if (next === 'new') assert.ok(!items.some(item => typeof item !== 'string' && item.value === 'keep'), 'Old key must not be offered for a new address');
        return items.find(item => typeof item === 'string' ? item === next : item.value === next);
      },
      showInputBox: async (form: Record<string, unknown>) => { forms.push(form); return inputs.shift(); },
      withProgress: async (_options: unknown, run: () => Promise<unknown>) => run(),
    },
  };
  const nativeRequire = createRequire(import.meta.url);
  const module = { exports: {} as { activate(context: unknown): void } };
  const secretStorage = {
    async get(name: string) { return values.get(name); },
    async store(name: string, value: string) { if (options.storeFailure) throw Error('unavailable'); values.set(name, value); },
    async delete(name: string) { values.delete(name); },
  };
  runInNewContext(readFileSync('extensions/vscode/out/extension.cjs', 'utf8'), {
    module, exports: module.exports, require: (name: string) => name === 'vscode' ? mock : nativeRequire(name),
    process: { platform: process.platform, env: { AGENT_GUARD_STATE_DIR: folder }, kill: process.kill.bind(process) },
    URL, AbortSignal, setInterval: () => 1, clearInterval() {}, console,
    fetch: async (input: string, init: RequestInit) => {
      const path = new URL(input).pathname;
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ path, ...(body ? { body } : {}) });
      if (path === '/api/state') return new Response(JSON.stringify({ workspaceRoot: folder, configured: true, ...(options.hydrate ? { credentialNeeded: reference } : {}) }));
      if (path === '/api/settings' && body) {
        if (options.saveFailure) return new Response('{}', { status: 400 });
        meta = { ...meta, settings: body.settings }; return new Response(JSON.stringify(meta));
      }
      if (path === '/api/settings') return new Response(JSON.stringify(meta));
      if (path === '/api/connection-check') return new Response(JSON.stringify({ ok: true, message: 'synthetic connection success' }));
      return new Response('{}');
    },
  });
  module.exports.activate({ subscriptions, secrets: secretStorage });
  await new Promise(resolve => setImmediate(resolve));
  if (options.picks.length) await commands.get('agentGuard.settings')!();
  for (const item of subscriptions) item.dispose?.();
  return { values, requests, forms, errors, reference, key, newKey };
}

test('native LLM wizard stores new key, does not reuse key at new address, sends only reference in settings', async t => {
  const f = await fixture(t, { picks: ['llm', 'new', undefined], inputs: ['https://new.invalid/v1', 'new-model', '30000', 'synthetic-new-private-key'] });
  const save = f.requests.find(r => r.path === '/api/settings' && r.body)!;
  assert.ok(!JSON.stringify(save).includes(f.newKey));
  assert.ok(f.requests.some(r => r.path === '/api/key' && r.body?.key === f.newKey));
  assert.equal(f.values.size, 1); assert.equal([...f.values.values()][0], f.newKey);
  const password = f.forms.at(-1)!; assert.equal(password.password, true); assert.equal(password.value, undefined);
  assert.equal(f.errors.length, 0);
});
test('storage failure prevents applying LLM configuration', async t => {
  const f = await fixture(t, { picks: ['llm', 'new'], inputs: ['https://new.invalid/v1', 'new-model', '30000', 'synthetic-new-private-key'], storeFailure: true });
  assert.ok(!f.requests.some(r => r.path === '/api/settings' && r.body));
  assert.equal(f.values.size, 1); assert.equal(f.errors.length, 1);
  assert.ok(!f.errors[0]!.includes(f.newKey));
});
test('failed save removes newly stored key and retains previous secret', async t => {
  const f = await fixture(t, { picks: ['llm', 'new'], inputs: ['https://new.invalid/v1', 'new-model', '30000', 'synthetic-new-private-key'], saveFailure: true });
  assert.equal(f.values.size, 1); assert.equal([...f.values.values()][0], f.key);
});
test('deleting selected key clears SecretStorage and in-memory credential', async t => {
  const f = await fixture(t, { picks: ['delete', 'Удалить выбранный ключ', undefined] });
  assert.equal(f.values.size, 0);
  assert.ok(f.requests.some(r => r.path === '/api/key' && r.body?.credentialRef === f.reference && !('key' in r.body)));
});
test('new extension host loads credential reference from SecretStorage without returning it to Webview', async t => {
  const f = await fixture(t, { picks: [], hydrate: true });
  assert.ok(f.requests.some(r => r.path === '/api/key' && r.body?.key === f.key));
  assert.ok(!f.requests.some(r => r.path === '/api/settings' && r.body));
});
test('native storage diagnostic removes its test value', async t => {
  const f = await fixture(t, { picks: ['storage', undefined] });
  assert.equal(f.values.size, 1); assert.equal(f.errors.length, 0);
});

test('native local-model selection removes credential reference and does not send a key', async t => {
  const f = await fixture(t, { picks: ['llm', 'none', undefined], inputs: ['http://localhost:1234/v1', 'local-qwen', '120000'] });
  const save = f.requests.find(r => r.path === '/api/settings' && r.body)!;
  const llm = (save.body!.settings as { llm: { authMode: string; credentialRef?: string } }).llm;
  assert.equal(llm.authMode, 'none'); assert.equal(llm.credentialRef, undefined);
  assert.ok(!f.requests.some(r => r.path === '/api/key'));
  assert.equal(f.values.size, 0);
});
