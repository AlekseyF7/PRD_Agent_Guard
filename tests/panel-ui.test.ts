import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { approvalPage } from '../src/approval/page.js';
import { parsePanelRecord, parseUiMessage, panelRequest } from '../extensions/vscode/src/connection.js';

const id = '11111111-1111-4111-8111-111111111111';
const action = { actionId: id, operation: 'execute_command', command: "printf 'guard-check'", cwd: '/synthetic', analysis: 'unknown', affectedPaths: [], risks: [] };
const explanation = { actionId: id, status: 'available', text: '- **Действие**: выводит `guard-check`.\n- **Риск**: <img src=x onerror="window.hacked=true">' };
const active = { phase: 'waiting', shell: 'posix-sh', action, explanation };
const ready = () => ({ workspaceRoot: '/synthetic', active, pending: { ...active, nonce: 'fake-nonce' }, last: undefined as unknown });
const complete = { status: 'completed', actionId: id, exitCode: 0, stdout: 'guard-check', stderr: '', stdoutTruncated: false, stderrTruncated: false };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('safe Markdown renders emphasis and code without creating HTML from the model', async t => {
  const state = ready();
  const dom = new JSDOM(approvalPage('test-nonce'), { runScripts: 'dangerously', url: 'http://127.0.0.1:1234/#token=fake-test-token', beforeParse(window) {
    Object.defineProperty(window, 'AbortSignal', { value: AbortSignal });
    window.fetch = async () => new Response(JSON.stringify(state));
  } }); t.after(() => dom.window.close()); await tick();
  const document = dom.window.document;
  assert.equal(document.querySelector('#explanation strong')?.textContent, 'Действие');
  assert.equal(document.querySelector('#explanation code')?.textContent, 'guard-check');
  assert.equal(document.querySelector('#explanation img'), null);
  assert.equal((dom.window as unknown as Record<string, unknown>).hacked, undefined);
  assert.ok(document.getElementById('explanation')!.textContent!.includes('<img'));
  assert.equal(document.getElementById('status')!.dataset.tone, 'waiting');
});
test('fast completion displays green result and stdout, not raw JSON on the main screen', async t => {
  let state: unknown = ready();
  const dom = new JSDOM(approvalPage('test-nonce'), { runScripts: 'dangerously', url: 'http://127.0.0.1:1234/#token=fake-test-token', beforeParse(window) {
    Object.defineProperty(window, 'AbortSignal', { value: AbortSignal });
    window.fetch = async (_input, init) => {
      if (init?.method === 'POST') { state = { workspaceRoot: '/synthetic', last: complete }; return new Response('{}'); }
      return new Response(JSON.stringify(state));
    };
  } }); t.after(() => dom.window.close()); await tick();
  dom.window.document.getElementById('allow')!.click(); await tick(); await tick();
  const document = dom.window.document;
  assert.equal(document.getElementById('status')!.dataset.tone, 'success');
  assert.equal(document.getElementById('result-summary')!.textContent, 'Выполнено');
  assert.equal(document.getElementById('stdout')!.textContent, 'guard-check');
  assert.equal(document.getElementById('command')!.textContent, action.command);
  assert.equal(document.querySelector('details')!.open, false);
  assert.ok(document.getElementById('buttons')!.hidden);
});
test('denial is visibly distinct from success', async t => {
  const state = { workspaceRoot: '/synthetic', last: { status: 'not_executed', code: 'DENIED', actionId: id, message: 'Действие не разрешено.' } };
  const dom = new JSDOM(approvalPage('test-nonce'), { runScripts: 'dangerously', url: 'http://127.0.0.1:1234/#token=fake-test-token', beforeParse(window) {
    Object.defineProperty(window, 'AbortSignal', { value: AbortSignal }); window.fetch = async () => new Response(JSON.stringify(state));
  } }); t.after(() => dom.window.close()); await tick();
  assert.equal(dom.window.document.getElementById('status')!.dataset.tone, 'denied');
  assert.match(dom.window.document.getElementById('result-summary')!.textContent!, /команда не запускалась/);
});
test('VS Code mode uses the host bridge and never requests a browser token', async t => {
  const messages: unknown[] = [];
  const html = approvalPage('test-nonce', 'vscode');
  assert.ok(html.includes("connect-src 'none'"));
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'http://webview.invalid/', beforeParse(window) {
    Object.defineProperty(window, 'acquireVsCodeApi', { value: () => ({ postMessage(message: { id: number; path: string }) {
      messages.push(message);
      window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'guard-response', id: message.id, ok: true, data: ready() } }));
    } }) });
    window.fetch = async () => { throw Error('Webview must not fetch HTTP'); };
  } }); t.after(() => dom.window.close()); await tick();
  assert.equal(messages.length, 1); assert.ok(!JSON.stringify(messages).includes('Bearer'));
  assert.equal(dom.window.document.getElementById('status')!.dataset.tone, 'waiting');
});

test('bridge restricts records and methods to the local approval API', () => {
  const valid = { pid: 123, workspaceRoot: '/synthetic', url: `http://127.0.0.1:1234/#token=${'a'.repeat(64)}` };
  assert.ok(parsePanelRecord(valid));
  for (const url of ['https://foreign.invalid/#token=abc', 'http://localhost:1234/#token=abc', `http://127.0.0.1:1234/other#token=${'a'.repeat(64)}`]) assert.equal(parsePanelRecord({ ...valid, url }), undefined);
  assert.equal(parseUiMessage({ type: 'guard-request', id: 1, path: 'https://foreign.invalid/' }), undefined);
  assert.equal(parseUiMessage({ type: 'guard-request', id: 1, path: '/api/state', body: { approve: true } }), undefined);
  assert.equal(parseUiMessage({ type: 'guard-request', id: 1, path: '/api/decision', body: { actionId: id, nonce: 'n', outcome: 'allow_all' } }), undefined);
});
test('host alone attaches credentials and fixed Origin; UI does not supply headers', async () => {
  const secret = 'b'.repeat(64);
  const record = { pid: 123, workspaceRoot: '/synthetic', url: `http://127.0.0.1:1234/#token=${secret}` };
  const result = await panelRequest(record, { type: 'guard-request', id: 1, path: '/api/state' }, async (input, init) => {
    assert.equal(String(input), 'http://127.0.0.1:1234/api/state');
    const headers = new Headers(init?.headers); assert.equal(headers.get('Authorization'), `Bearer ${secret}`); assert.equal(headers.get('Origin'), 'http://127.0.0.1:1234');
    return new Response(JSON.stringify({ workspaceRoot: '/synthetic' }));
  });
  assert.ok(!JSON.stringify(result).includes(secret));
});

test('execution state is blue and offers cancellation without approval buttons', async t => {
  const state = { workspaceRoot: '/synthetic', active: { ...active, phase: 'executing' } };
  const dom = new JSDOM(approvalPage('test-nonce'), { runScripts: 'dangerously', url: 'http://127.0.0.1:1234/#token=fake-test-token', beforeParse(window) {
    Object.defineProperty(window, 'AbortSignal', { value: AbortSignal }); window.fetch = async () => new Response(JSON.stringify(state));
  } }); t.after(() => dom.window.close()); await tick();
  const document = dom.window.document;
  assert.equal(document.getElementById('status')!.dataset.tone, 'running');
  assert.match(document.getElementById('status')!.textContent!, /Выполняется/);
  assert.equal(document.getElementById('buttons')!.hidden, true);
  assert.equal(document.getElementById('cancel')!.hidden, false);
});
test('disconnect preserves last known result and hides stale actions', async t => {
  let online = true; let poll!: () => void;
  const state = { workspaceRoot: '/synthetic', last: complete };
  const dom = new JSDOM(approvalPage('test-nonce'), { runScripts: 'dangerously', url: 'http://127.0.0.1:1234/#token=fake-test-token', beforeParse(window) {
    Object.defineProperty(window, 'AbortSignal', { value: AbortSignal });
    window.setInterval = ((callback: () => void) => { poll = callback; return 1; }) as typeof window.setInterval;
    window.fetch = async () => { if (!online) throw new TypeError('Failed to fetch'); return new Response(JSON.stringify(state)); };
  } }); t.after(() => dom.window.close()); await tick();
  online = false; poll(); await tick();
  const document = dom.window.document;
  assert.equal(document.getElementById('status')!.dataset.tone, 'offline');
  assert.equal(document.getElementById('stdout')!.textContent, 'guard-check');
  assert.equal(document.getElementById('result-summary')!.textContent, 'Выполнено');
  assert.ok(!document.getElementById('error')!.textContent!.includes('Failed to fetch'));
  assert.equal(document.getElementById('cancel')!.hidden, true);
});

test('history is loaded on expansion, renders untrusted text safely, and has no approval controls', async t => {
  let historyReads = 0;
  const state = { workspaceRoot: '/synthetic', historyCount: 1, historyVersion: 1, last: complete };
  const entries = [{ finishedAt: new Date().toISOString(), command: '<img src=x onerror=alert(1)>', cwd: '/synthetic', explanation: '**Описание** <script>unsafe</script>', decision: 'allow_once', result: complete, shortened: true }];
  const dom = new JSDOM(approvalPage('test-nonce'), { runScripts: 'dangerously', url: 'http://127.0.0.1:1234/#token=fake-test-token', beforeParse(window) {
    Object.defineProperty(window, 'AbortSignal', { value: AbortSignal });
    window.fetch = async input => {
      if (String(input) === '/api/history') { historyReads++; return new Response(JSON.stringify(entries)); }
      return new Response(JSON.stringify(state));
    };
  } }); t.after(() => dom.window.close()); await tick();
  assert.equal(historyReads, 0);
  const history = dom.window.document.getElementById('history') as HTMLDetailsElement;
  history.open = true; history.dispatchEvent(new dom.window.Event('toggle')); await tick();
  const list = dom.window.document.getElementById('history-list')!;
  assert.ok(list.textContent!.includes('<img')); assert.ok(list.textContent!.includes('сокращены'));
  assert.equal(list.querySelector('img,script,button'), null);
  assert.equal(list.querySelector('strong')?.textContent, 'Описание');
});
