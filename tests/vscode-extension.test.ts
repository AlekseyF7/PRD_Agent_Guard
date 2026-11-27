import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';

test('bundled extension auto-opens a secret-free Webview and exposes no approval command', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'guard-extension-'));
  const secret = 'c'.repeat(64);
  writeFileSync(join(directory, `${process.pid}.json`), JSON.stringify({ pid: process.pid, workspaceRoot: directory, url: `http://127.0.0.1:1234/#token=${secret}` }));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const action = { actionId: '11111111-1111-4111-8111-111111111111', command: 'echo synthetic', cwd: directory, risks: [], affectedPaths: [], analysis: 'unknown' };
  const explanation = { actionId: action.actionId, status: 'available', text: 'Синтетическое объяснение.' };
  const state = { workspaceRoot: directory, active: { phase: 'waiting', shell: 'posix-sh', action, explanation }, pending: { action, explanation, shell: 'posix-sh', nonce: 'synthetic' } };
  let html = ''; let created = 0; let preserveFocus: unknown;
  const commands = new Map<string, unknown>(); const subscriptions: { dispose?(): void }[] = [];
  const bar = { text: '', tooltip: '', command: '', show() {}, dispose() {} };
  const mockVscode = {
    StatusBarAlignment: { Right: 1 }, ViewColumn: { Beside: 2 },
    workspace: { workspaceFolders: [{ uri: { fsPath: directory } }], getConfiguration: () => ({ get: () => true }) },
    commands: { registerCommand(name: string, callback: unknown) { commands.set(name, callback); return { dispose() {} }; } },
    window: { createStatusBarItem: () => bar, createWebviewPanel(_kind: string, _title: string, column: { preserveFocus: boolean }) {
      created++; preserveFocus = column.preserveFocus;
      return { webview: { set html(value: string) { html = value; }, onDidReceiveMessage() {}, postMessage: async () => true }, onDidDispose() {}, reveal() {}, dispose() {} };
    }, showInformationMessage() {}, showQuickPick: async () => undefined },
  };
  const nativeRequire = createRequire(import.meta.url);
  const module = { exports: {} as { activate(context: unknown): void } };
  const context = {
    module, exports: module.exports, require: (name: string) => name === 'vscode' ? mockVscode : nativeRequire(name),
    process: { platform: process.platform, env: { AGENT_GUARD_STATE_DIR: directory }, kill: process.kill.bind(process) },
    URL, AbortSignal, setInterval: () => 1, clearInterval() {}, console,
    fetch: async (_input: unknown, init: RequestInit) => {
      assert.equal(new Headers(init.headers).get('Authorization'), `Bearer ${secret}`);
      return new Response(JSON.stringify(state));
    },
  };
  runInNewContext(readFileSync('extensions/vscode/out/extension.cjs', 'utf8'), context);
  module.exports.activate({ subscriptions });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(created, 1); assert.equal(preserveFocus, true);
  assert.deepEqual([...commands.keys()].sort(), ['agentGuard.openPanel', 'agentGuard.selectServer', 'agentGuard.settings']);
  assert.ok(!html.includes(secret)); assert.match(bar.text, /нужно решение/);
  // Check the actual bundled function's serialized Webview script, not just source.
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'http://webview.invalid/', beforeParse(window) {
    Object.defineProperty(window, 'acquireVsCodeApi', { value: () => ({ postMessage(message: { id: number }) {
      window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'guard-response', id: message.id, ok: true, data: state } }));
    } }) });
    window.fetch = async () => { throw Error('No direct HTTP in Webview'); };
  } }); t.after(() => dom.window.close());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(dom.window.document.getElementById('status')!.dataset.tone, 'waiting');
  for (const disposable of subscriptions) disposable?.dispose?.();
});
