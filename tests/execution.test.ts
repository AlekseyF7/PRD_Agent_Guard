import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore, DEFAULT_POLICIES } from '../src/core/index.js';
import type { Action, Explanation, UserDecision } from '../src/core/types.js';
import { createExecutionService } from '../src/execution/service.js';
import { createProcessExecutor, commandEnvironment, shellCommand } from '../src/execution/process.js';
import { createApprovalBroker } from '../src/approval/broker.js';
import { noPosixParsing, parsePowerShell, powerShellRule } from '../src/execution/powershell.js';
import type { ExecutionDependencies, ProcessResult } from '../src/execution/types.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'guard-execution-')));
after(() => rmSync(root, { recursive: true, force: true }));
const request = (command = 'echo synthetic') => ({ command, cwd: root });
const core = createCore({ workspaceRoot: root, mode: 'paranoid', policies: DEFAULT_POLICIES });
const success: ProcessResult = { status: 'completed', exitCode: 0, stdout: 'synthetic', stderr: '', stdoutTruncated: false, stderrTruncated: false };
const explain = async (action: Action): Promise<Explanation> => ({ actionId: action.actionId, status: 'available', text: 'Синтетическое действие' });
const approve: ExecutionDependencies['approve'] = async ({ action }) => ({ actionId: action.actionId, outcome: 'allow_once' });
const dependencies = (overrides: Partial<ExecutionDependencies> = {}): ExecutionDependencies => ({ check: core.check, explain, approve, execute: async () => success, shell: 'posix-sh', approvalTimeoutMs: 1000, ...overrides });
const pause = () => new Promise(resolve => setImmediate(resolve));

test('policy block skips LLM, UI and execution', async () => {
  const instance = createExecutionService(dependencies({ check: () => ({ decision: 'block', code: 'INVALID_REQUEST', reason: 'Invalid' }), explain: async () => { throw Error('unexpected'); }, approve: async () => { throw Error('unexpected'); }, execute: async () => { throw Error('unexpected'); } }));
  assert.equal((await instance.run(request())).status, 'not_executed');
});
for (const outcome of ['deny', 'cancel', 'error', 'no_answer', 'allow_once_without_explanation'] as const) test(`no execution for ${outcome} with available explanation`, async () => {
  let launches = 0;
  const instance = createExecutionService(dependencies({ approve: async ({ action }) => ({ actionId: action.actionId, outcome }), execute: async () => { launches++; return success; } }));
  assert.equal((await instance.run(request())).status, 'not_executed'); assert.equal(launches, 0);
});
test('unavailable explanation accepts only an explicit degraded approval', async () => {
  for (const outcome of ['allow_once', 'deny', 'allow_once_without_explanation'] as const) {
    let launches = 0;
    const instance = createExecutionService(dependencies({ explain: async a => ({ actionId: a.actionId, status: 'unavailable', error: { code: 'TIMEOUT', message: 'Unavailable' } }), approve: async ({ action }) => ({ actionId: action.actionId, outcome }), execute: async () => { launches++; return success; } }));
    await instance.run(request()); assert.equal(launches, outcome === 'allow_once_without_explanation' ? 1 : 0);
  }
});
test('broken explanation falls back to unavailable without executing automatically', async () => {
  let calls = 0;
  const instance = createExecutionService(dependencies({ explain: async () => { throw Error('private'); }, approve: async ({ action, explanation }) => { assert.equal(explanation.status, 'unavailable'); return { actionId: action.actionId, outcome: 'deny' }; }, execute: async () => { calls++; return success; } }));
  await instance.run(request()); assert.equal(calls, 0);
});
test('approved snapshot runs once; a new call gets a fresh identity', async () => {
  const seen: string[] = [];
  const instance = createExecutionService(dependencies({ execute: async a => { seen.push(a.actionId); assert.equal(a.command, 'echo synthetic'); return success; } }));
  assert.equal((await instance.run(request())).status, 'completed'); await instance.run(request());
  assert.equal(seen.length, 2); assert.notEqual(seen[0], seen[1]);
});
test('BUSY rejects a parallel request and cancel prevents a late LLM result', async () => {
  let release!: (e: Explanation) => void; let saved!: Action; let launches = 0;
  const instance = createExecutionService(dependencies({ explain: a => { saved = a; return new Promise(resolve => { release = resolve; }); }, execute: async () => { launches++; return success; } }));
  const first = instance.run(request()); await pause();
  const second = await instance.run(request()); assert.ok(second.status === 'not_executed' && second.code === 'BUSY');
  instance.cancel(); assert.equal((await first).status, 'not_executed');
  release({ actionId: saved.actionId, status: 'available', text: 'late' }); await pause(); assert.equal(launches, 0);
});
test('approval timeout and external disconnect never invoke executor', async () => {
  for (const disconnect of [false, true]) {
    const broker = createApprovalBroker(); let launches = 0; const external = new AbortController();
    const instance = createExecutionService(dependencies({ approve: broker.request, approvalTimeoutMs: 20, execute: async () => { launches++; return success; } }));
    const pending = instance.run(request(), external.signal); await pause(); if (disconnect) external.abort();
    const result = await pending; assert.equal(result.status, 'not_executed'); assert.equal(broker.state(), undefined); assert.equal(launches, 0);
  }
});
test('changed files after explanation invalidate approval', async () => {
  writeFileSync(join(root, 'sample.txt'), 'before'); let launches = 0;
  const instance = createExecutionService(dependencies({ approve: async ({ action }) => { writeFileSync(join(root, 'sample.txt'), 'changed longer content'); return { actionId: action.actionId, outcome: 'allow_once' }; }, execute: async () => { launches++; return success; } }));
  const result = await instance.run(request('rm -- sample.txt'));
  assert.ok(result.status === 'not_executed' && result.code === 'STALE_ACTION'); assert.equal(launches, 0);
});
test('configuration replacement cancels an old decision', async () => {
  const broker = createApprovalBroker(); const instance = createExecutionService(dependencies({ approve: broker.request }));
  const pending = instance.run(request()); await pause(); const old = broker.state()!;
  instance.replace(dependencies()); assert.equal((await pending).status, 'not_executed');
  assert.equal(broker.submit(old.action.actionId, old.nonce, 'allow_once'), false);
});
test('foreign actionId in a decision or explanation is rejected', async () => {
  const wrongDecision = createExecutionService(dependencies({ approve: async () => ({ actionId: 'other', outcome: 'allow_once' }) }));
  assert.equal((await wrongDecision.run(request())).status, 'not_executed');
  const wrongExplanation = createExecutionService(dependencies({ explain: async () => ({ actionId: 'other', status: 'available', text: 'not this action' }) }));
  assert.equal((await wrongExplanation.run(request())).status, 'not_executed');
});
test('duplicate UI messages accept one decision, not two', async () => {
  const broker = createApprovalBroker(); const controller = new AbortController(); const checked = core.check(request()); assert.equal(checked.decision, 'ask'); if (checked.decision !== 'ask') return;
  const pending = broker.request({ action: checked.action, explanation: await explain(checked.action), shell: 'posix-sh' }, controller.signal);
  const data = broker.state()!;
  assert.equal(broker.submit(data.action.actionId, 'wrong nonce', 'allow_once'), false);
  assert.equal(broker.submit(data.action.actionId, data.nonce, 'allow_once'), true);
  assert.equal(broker.submit(data.action.actionId, data.nonce, 'allow_once'), false);
  assert.equal((await pending).outcome, 'allow_once');
});
test('execution exception after start is an unknown result, never a safe block', async () => {
  const instance = createExecutionService(dependencies({ execute: async () => { throw Error('crash'); } }));
  assert.equal((await instance.run(request())).status, 'unknown');
});
test('PowerShell lexer preserves Windows backslashes and literal quotes', () => {
  const parsed = parsePowerShell("Remove-Item -LiteralPath 'C:\\project\\a b.txt'");
  assert.equal(parsed.segments[0]![2]!.value, 'C:\\project\\a b.txt');
  assert.equal(parsed.segments[0]![2]!.literal, true);
  assert.equal(parsePowerShell("echo 'it''s fine'").segments[0]![1]!.value, "it's fine");
});
for (const command of ['Remove-Item sample.txt', 'del sample.txt', 'rm -LiteralPath sample.txt', 'Remove-Item "$file"', 'git reset --hard']) test(`Windows profile detects bounded risk: ${command}`, () => {
  const instance = createCore({ workspaceRoot: root, mode: 'paranoid', policies: { ...DEFAULT_POLICIES, file_delete: 'block', git_destructive: 'block' } }, [powerShellRule], noPosixParsing);
  const result = instance.check(request(command)); assert.equal(result.decision, 'block');
  assert.ok('action' in result && result.action.analysis === 'partial');
});
test('PowerShell quoted text is not executed as a deletion', () => {
  const instance = createCore({ workspaceRoot: root, mode: 'paranoid', policies: { ...DEFAULT_POLICIES, file_delete: 'block' } }, [powerShellRule], noPosixParsing);
  assert.equal(instance.check(request("Write-Output 'Remove-Item sample.txt'")).decision, 'ask');
});
test('Windows shell uses an exact UTF-16 encoded command and no profile', () => {
  const command = 'Write-Output "привет"'; const spec = shellCommand(command, 'windows-powershell');
  assert.ok(spec.file.endsWith('powershell.exe')); assert.ok(spec.args.includes('-NoProfile'));
  assert.equal(Buffer.from(spec.args.at(-1)!, 'base64').toString('utf16le'), command);
});
test('child environment excludes LLM and UI credentials', () => {
  assert.deepEqual(commandEnvironment({ PATH: '/synthetic', AGENT_GUARD_LLM_API_KEY: 'not-real', UI_TOKEN: 'not-real', OTHER_SECRET: 'not-real' }), { PATH: '/synthetic' });
});
const profile = process.platform === 'win32' ? 'windows-powershell' : 'posix-sh';
const snapshot = (command: string): Action => { const c = core.check(request(command)); if (c.decision !== 'ask') throw Error('Fixture invalid'); return c.action; };
test('real safe process returns output and nonzero exit without claiming success', async () => {
  const execute = createProcessExecutor({ shell: profile, timeoutMs: 10000, outputLimitBytes: 65536 });
  const good = await execute(snapshot(process.platform === 'win32' ? "Write-Output 'synthetic'" : "printf 'synthetic'"), new AbortController().signal);
  assert.equal(good.status, 'completed'); assert.match(good.stdout, /synthetic/);
  const bad = await execute(snapshot('exit 7'), new AbortController().signal); assert.equal(bad.exitCode, 7);
});
test('real safe process output is capped while streaming', async () => {
  const execute = createProcessExecutor({ shell: profile, timeoutMs: 10000, outputLimitBytes: 32 });
  const command = process.platform === 'win32' ? "Write-Output ('x' * 10000)" : "i=0; while [ $i -lt 1000 ]; do printf x; i=$((i+1)); done";
  const result = await execute(snapshot(command), new AbortController().signal);
  assert.equal(result.stdoutTruncated, true); assert.equal(Buffer.byteLength(result.stdout), 32);
});
test('real process timeout/cancellation are distinct from normal completion', async () => {
  for (const cancel of [false, true]) {
    const execute = createProcessExecutor({ shell: profile, timeoutMs: cancel ? 10000 : 50, outputLimitBytes: 64 });
    const controller = new AbortController();
    const result = execute(snapshot(process.platform === 'win32' ? 'Start-Sleep -Seconds 10' : 'sleep 10'), controller.signal);
    if (cancel) setTimeout(() => controller.abort(), 50);
    assert.equal((await result).code, cancel ? 'CANCELLED' : 'TIMEOUT');
  }
});

test('POSIX timeout stops descendant before its delayed file write', { skip: process.platform === 'win32' }, async () => {
  const marker = join(root, 'late-marker'); rmSync(marker, { force: true });
  const execute = createProcessExecutor({ shell: 'posix-sh', timeoutMs: 50, outputLimitBytes: 64 });
  const result = await execute(snapshot('(sleep 0.3; printf late > late-marker) & wait'), new AbortController().signal);
  assert.equal(result.code, 'TIMEOUT');
  await new Promise(resolve => setTimeout(resolve, 400));
  const { existsSync } = await import('node:fs'); assert.equal(existsSync(marker), false);
});
test('missing execution cwd gives a safe spawn error', async () => {
  const execute = createProcessExecutor({ shell: profile, timeoutMs: 1000, outputLimitBytes: 64 });
  const result = await execute({ ...snapshot('echo synthetic'), cwd: join(root, 'missing-directory') }, new AbortController().signal);
  assert.equal(result.status, 'execution_error'); assert.equal(result.code, 'SPAWN_ERROR');
});
