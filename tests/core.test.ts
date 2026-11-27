import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, createCore, DEFAULT_POLICIES, validateConfig } from '../src/core/index.js';
import type { Action, CheckResult, CoreConfig, Explanation, PolicyCategory, RiskRule, UserDecision } from '../src/core/index.js';

const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'agent-guard-core-')));
const root = join(sandbox, 'project');
const outside = join(sandbox, 'project-copy');
mkdirSync(root); mkdirSync(outside); mkdirSync(join(root, 'src'));
writeFileSync(join(root, 'sample.txt'), 'synthetic data');
writeFileSync(join(outside, 'external.txt'), 'synthetic data');
symlinkSync(outside, join(root, 'external-link'), process.platform === 'win32' ? 'junction' : undefined);
symlinkSync(join(root, 'src'), join(root, 'internal-link'), process.platform === 'win32' ? 'junction' : undefined);
symlinkSync(join(sandbox, 'does-not-exist'), join(root, 'dangling'), process.platform === 'win32' ? 'junction' : undefined);
after(() => rmSync(sandbox, { recursive: true, force: true }));
const config = (): CoreConfig => ({ workspaceRoot: root, mode: 'paranoid', policies: { ...DEFAULT_POLICIES } });
const request = (command = 'rm -- sample.txt', cwd = root) => ({ command, cwd });
const core = createCore(config());
function action(result: CheckResult): Action {
  assert.ok('action' in result, JSON.stringify(result));
  return result.action;
}
function blocked(input: unknown, code: string) {
  const result = core.check(input);
  assert.equal(result.decision, 'block');
  assert.ok('code' in result);
  assert.equal(result.code, code);
  assert.equal('action' in result, false);
}
function policyCore(category: PolicyCategory) {
  const input = config();
  return createCore({ ...input, policies: { ...input.policies, [category]: 'block' } });
}

for (const [name, input] of Object.entries({
  null: null, array: [], string: 'rm sample.txt', missingCwd: { command: 'ls' },
  missingCommand: { cwd: root }, numberCommand: { command: 2, cwd: root },
  numberCwd: { command: 'ls', cwd: 2 }, approved: { ...request(), approved: true },
  userApproved: { ...request(), user_approved: true }, actionId: { ...request(), actionId: 'old-id' },
  policies: { ...request(), policies: { file_delete: 'ask' } },
  inherited: Object.create(request()), symbol: { ...request(), [Symbol('extra')]: true },
  getter: { get command() { throw new Error('private error'); }, cwd: root },
})) test(`invalid request: ${name}`, () => blocked(input, 'INVALID_REQUEST'));

for (const command of ['', ' \t\n', 'ls\0']) test(`invalid command: ${JSON.stringify(command)}`, () => blocked(request(command), 'INVALID_COMMAND'));
for (const cwd of ['relative', join(sandbox, 'absent'), join(root, 'sample.txt'), `${root}\0`]) {
  test(`invalid cwd: ${JSON.stringify(cwd)}`, () => blocked(request('ls', cwd), 'INVALID_CWD'));
}

for (const [name, make] of Object.entries({
  missingRoot: () => ({ mode: 'paranoid', policies: DEFAULT_POLICIES }),
  relativeRoot: () => ({ ...config(), workspaceRoot: 'relative' }),
  absentRoot: () => ({ ...config(), workspaceRoot: join(sandbox, 'absent') }),
  fileRoot: () => ({ ...config(), workspaceRoot: join(root, 'sample.txt') }),
  fast: () => ({ ...config(), mode: 'fast' }),
  allowPolicy: () => ({ ...config(), policies: { ...DEFAULT_POLICIES, file_delete: 'allow' } }),
  missingPolicy: () => ({ ...config(), policies: { file_delete: 'ask' } }),
  extraPolicy: () => ({ ...config(), policies: { ...DEFAULT_POLICIES, secret: 'block' } }),
  extraSetting: () => ({ ...config(), approved: true }),
})) test(`invalid config: ${name}`, () => assert.throws(() => createCore(make()), { name: 'ConfigError', code: 'INVALID_CONFIG' }));
test('configuration error has no raw path/system exception', () => {
  assert.throws(() => validateConfig(null), (error: unknown) => error instanceof ConfigError && !error.message.includes(sandbox));
});

for (const command of ['ls', 'echo hello', 'unknown-tool argument', "echo 'rm sample.txt'", 'git status', 'git log']) {
  test(`Paranoid asks without claiming safety: ${command}`, () => {
    const result = core.check(request(command));
    assert.equal(result.decision, 'ask');
    assert.equal(action(result).analysis, 'unknown');
    assert.deepEqual(action(result).risks, []);
  });
}
for (const command of ['rm sample.txt', 'rm -- sample.txt', 'rm -rf src', '/bin/rm -v sample.txt', 'rm "sample.txt"', 'rm sample\\.txt']) {
  test(`deletion rule: ${command}`, () => {
    const result = core.check(request(command));
    assert.equal(result.decision, 'ask');
    assert.ok(action(result).risks.some(r => r.category === 'file_delete'));
    assert.ok(action(result).affectedPaths.length > 0);
    assert.equal(policyCore('file_delete').check(request(command)).decision, 'block');
  });
}
for (const [command, category] of [
  ['git reset --hard', 'git_destructive'], ['git reset --hard HEAD~1', 'git_destructive'],
  ['git clean -f', 'git_destructive'], ['git clean -fdx', 'git_destructive'],
  ['git clean --force', 'git_destructive'], ['/usr/bin/git clean -fd', 'git_destructive'],
  ['git push --force', 'git_force_push'], ['git push --force \"$BRANCH\"', 'git_force_push'], ['git push origin main -f', 'git_force_push'],
  ['git push --force-with-lease', 'git_force_push'], ['git push --force-with-lease=main:abc', 'git_force_push'],
] as const) test(`git risk: ${command}`, () => {
  const result = policyCore(category).check(request(command));
  assert.equal(result.decision, 'block');
  assert.ok(action(result).risks.some(r => r.category === category));
  assert.equal(action(result).analysis, 'partial');
});
for (const command of ['git clean -nfd', 'git clean --dry-run -f', 'git reset -- --hard', 'git push origin -- -f', 'echo > rm']) {
  test(`not a known destructive invocation: ${command}`, () => {
    const result = policyCore('file_delete').check(request(command));
    assert.equal(result.decision, 'ask');
    assert.deepEqual(action(result).risks, []);
  });
}
for (const command of ['rm *.txt', 'rm "$TARGET"', 'sh -c "rm sample.txt"', 'git -C src reset --hard', "echo 'unterminated", 'rm sample.txt; echo done']) {
  test(`bounded analysis: ${command}`, () => {
    assert.notEqual(action(core.check(request(command))).analysis, 'recognized');
  });
}
test('compound command retains a known block', () => {
  const result = policyCore('file_delete').check(request('echo start && rm sample.txt; ls'));
  assert.equal(result.decision, 'block');
  assert.equal(action(result).analysis, 'partial');
});
test('redirect target is not treated as an rm operand', () => {
  const snapshot = action(core.check(request('rm sample.txt > output.txt')));
  assert.deepEqual(snapshot.affectedPaths, [join(root, 'sample.txt')]);
  assert.equal(snapshot.analysis, 'partial');
});
test('quoted wildcard is a literal target; expanded wildcard is not', () => {
  assert.deepEqual(action(core.check(request("rm '*.txt'"))).affectedPaths, [join(root, '*.txt')]);
  assert.deepEqual(action(core.check(request('rm *.txt'))).affectedPaths, []);
});

test('root and nested cwd are inside the workspace', () => {
  assert.equal(core.check(request('ls', root)).decision, 'ask');
  assert.equal(core.check(request('ls', join(root, 'src'))).decision, 'ask');
});
test('similar prefix outside cwd is blocked; policy can switch to ask', () => {
  assert.equal(core.check(request('ls', outside)).decision, 'block');
  const input = config();
  assert.equal(createCore({ ...input, policies: { ...input.policies, outside_workspace: 'ask' } }).check(request('ls', outside)).decision, 'ask');
});
test('cwd symlinks are canonicalized before policy checks', () => {
  assert.equal(action(core.check(request('ls', join(root, 'internal-link')))).cwd, join(root, 'src'));
  assert.equal(core.check(request('ls', join(root, 'external-link'))).decision, 'block');
});
for (const operand of ['../project-copy/external.txt', 'external-link/external.txt', 'external-link/new-file', 'external-link/../elsewhere']) {
  test(`outside deletion target: ${operand}`, () => {
    const result = core.check(request(`rm ${operand}`));
    assert.equal(result.decision, 'block');
    assert.ok(action(result).risks.some(r => r.category === 'outside_workspace'));
  });
}
test('unknown dangling-link target is not claimed internal', () => {
  const snapshot = action(core.check(request('rm dangling/child')));
  assert.deepEqual(snapshot.affectedPaths, []);
  assert.equal(snapshot.analysis, 'partial');
});
test('missing target inside workspace can be represented without claiming it exists', () => {
  assert.deepEqual(action(core.check(request('rm absent/nested/file'))).affectedPaths, [join(root, 'absent/nested/file')]);
});
test('any block wins over ask from another rule', () => {
  const result = core.check(request('rm ../project-copy/external.txt'));
  assert.equal(result.decision, 'block');
  assert.ok('code' in result && result.code === 'POLICY_BLOCK');
});
test('snapshots preserve exact command; repeats and changed args get fresh UUIDs', () => {
  const a = action(core.check(request('  rm -- sample.txt  ')));
  const b = action(core.check(request('  rm -- sample.txt  ')));
  const c = action(core.check(request('ls', join(root, 'src'))));
  assert.equal(a.command, '  rm -- sample.txt  ');
  assert.match(a.actionId, /^[0-9a-f-]{36}$/);
  assert.notEqual(a.actionId, b.actionId);
  assert.notEqual(a.actionId, c.actionId);
});
test('input mutation cannot change the deeply frozen result', () => {
  const input = request();
  const result = core.check(input);
  const snapshot = action(result);
  input.command = 'changed'; input.cwd = outside;
  assert.equal(snapshot.command, 'rm -- sample.txt');
  assert.equal(snapshot.cwd, root);
  assert.throws(() => Object.assign(snapshot, { command: 'changed' }), TypeError);
  assert.throws(() => Object.assign(snapshot.risks[0]!, { reason: 'changed' }), TypeError);
  assert.throws(() => (snapshot.affectedPaths as string[]).push('changed'), TypeError);
  assert.throws(() => Object.assign(result, { decision: 'allow' }), TypeError);
});
test('config input mutation cannot change active policies', () => {
  const input = { ...config(), policies: { ...DEFAULT_POLICIES, file_delete: 'block' as 'block' | 'ask' } };
  const instance = createCore(input);
  input.policies.file_delete = 'ask';
  assert.equal(instance.check(request()).decision, 'block');
  assert.throws(() => Object.assign(instance.config.policies, { file_delete: 'ask' }), TypeError);
});
test('additional rule extends the registry without replacing default protection', () => {
  let calls = 0;
  const custom: RiskRule = { id: 'example.extra', analyze: () => {
    calls++;
    return { analysis: 'partial', affectedPaths: [], risks: [{ ruleId: 'example.extra', category: 'git_force_push', reason: 'Synthetic risk' }] };
  } };
  const result = createCore(config(), [custom]).check(request('ls', outside));
  assert.equal(calls, 1);
  assert.equal(result.decision, 'block');
  assert.equal(action(result).risks.length, 2);
});
test('broken rule fails closed without leaking its exception', () => {
  const broken: RiskRule = { id: 'example.broken', analyze() { throw new Error('private internal data'); } };
  const result = createCore(config(), [broken]).check(request());
  assert.equal(result.decision, 'block');
  assert.ok('code' in result && result.code === 'CHECK_FAILED');
  assert.equal('action' in result, false);
  assert.ok(!result.reason.includes('private'));
});
test('duplicate rule ids are rejected', () => {
  const rule: RiskRule = { id: 'shell.rm', analyze: () => ({ analysis: 'unknown', risks: [], affectedPaths: [] }) };
  assert.throws(() => createCore(config(), [rule]), ConfigError);
});
test('exchange fixtures type-check without asserting a trusted UI exists', () => {
  const snapshot = action(core.check(request()));
  const available = { actionId: snapshot.actionId, status: 'available', text: 'Удаление тестового файла' } satisfies Explanation;
  const unavailable = { actionId: snapshot.actionId, status: 'unavailable', error: { code: 'TIMEOUT', message: 'Объяснение недоступно' } } satisfies Explanation;
  const decision = { actionId: snapshot.actionId, outcome: 'allow_once_without_explanation' } satisfies UserDecision;
  assert.equal(available.actionId, unavailable.actionId);
  assert.equal(decision.actionId, snapshot.actionId);
});

test('git clean exclusion pattern is not a dry-run flag', () => {
  for (const command of ['git clean -e -n -f', 'git clean --exclude --dry-run -f', 'git clean -e-n -f']) {
    assert.equal(policyCore('git_destructive').check(request(command)).decision, 'block');
  }
});
test('relative paths after potential directory changes are not guessed', () => {
  const result = core.check(request('cd ../project-copy; rm external.txt'));
  assert.equal(action(result).analysis, 'partial');
  assert.deepEqual(action(result).affectedPaths, []);
  assert.ok(action(result).risks.some(r => r.category === 'file_delete'));
});
test('absolute outside target is still blocked in a compound command', () => {
  assert.equal(core.check(request(`echo start; rm ${outside}/external.txt`)).decision, 'block');
});
test('removing cwd after initialization produces an invalid-cwd block', () => {
  const ephemeral = join(sandbox, 'ephemeral');
  mkdirSync(ephemeral);
  const instance = createCore({ ...config(), workspaceRoot: ephemeral });
  rmSync(ephemeral, { recursive: true });
  const result = instance.check(request('ls', ephemeral));
  assert.equal(result.decision, 'block');
  assert.ok('code' in result && result.code === 'INVALID_CWD');
});
