import { randomUUID } from 'node:crypto';
import { canonicalDirectory } from './paths.js';
import { DEFAULT_RULES } from './rules.js';
import { parseCommand } from './shell.js';
import { POLICY_CATEGORIES } from './types.js';
import type { Action, Analysis, CheckError, CheckResult, CoreConfig, PolicyCategory, RiskRule } from './types.js';

export const DEFAULT_POLICIES = Object.freeze({
  file_delete: 'ask', git_destructive: 'ask', git_force_push: 'ask', outside_workspace: 'block',
} as const);

export class ConfigError extends Error {
  readonly code = 'INVALID_CONFIG';
  constructor() { super('Некорректная конфигурация Agent Guard.'); this.name = 'ConfigError'; }
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor && descriptor.enumerable;
  });
}

export function validateConfig(input: unknown): CoreConfig {
  try {
    if (!exactRecord(input, ['workspaceRoot', 'mode', 'policies']) || input.mode !== 'paranoid') throw new ConfigError();
    const workspaceRoot = canonicalDirectory(input.workspaceRoot);
    if (!workspaceRoot || !exactRecord(input.policies, POLICY_CATEGORIES)) throw new ConfigError();
    const policies = {} as Record<PolicyCategory, 'ask' | 'block'>;
    for (const key of POLICY_CATEGORIES) {
      const value = input.policies[key];
      if (value !== 'ask' && value !== 'block') throw new ConfigError();
      policies[key] = value;
    }
    return Object.freeze({ workspaceRoot, mode: 'paranoid', policies: Object.freeze(policies) });
  } catch { throw new ConfigError(); }
}

const reject = (code: CheckError, reason: string): CheckResult => Object.freeze({ decision: 'block', code, reason });

export function createCore(input: unknown, additionalRules: readonly RiskRule[] = [], parser = parseCommand) {
  const config = validateConfig(input);
  // Additional rules extend defaults instead of silently disabling workspace checks.
  const registry = [...DEFAULT_RULES, ...additionalRules]
    .map(rule => Object.freeze({ id: rule.id, analyze: rule.analyze }));
  if (registry.some(rule => !rule.id || typeof rule.analyze !== 'function') || new Set(registry.map(r => r.id)).size !== registry.length) throw new ConfigError();

  function check(request: unknown): CheckResult {
    try {
      if (!exactRecord(request, ['command', 'cwd']) || typeof request.command !== 'string' || typeof request.cwd !== 'string') return reject('INVALID_REQUEST', 'Ожидаются только строковые command и cwd.');
      const command = request.command;
      if (!command.trim() || command.includes('\0')) return reject('INVALID_COMMAND', 'Команда должна быть непустой строкой без NUL.');
      const cwd = canonicalDirectory(request.cwd);
      if (!cwd) return reject('INVALID_CWD', 'Рабочая папка должна быть существующей абсолютной папкой.');
      const parsed = parser(command);
      const context = Object.freeze({ command, parsed: freezeParsed(parsed), cwd, workspaceRoot: config.workspaceRoot });
      const results = registry.map(rule => rule.analyze(context));
      const risks = results.flatMap(result => result.risks).map(risk => {
        if (!POLICY_CATEGORIES.includes(risk.category) || !risk.ruleId || !risk.reason) throw new Error('Invalid rule result');
        return Object.freeze({ ruleId: risk.ruleId, category: risk.category, reason: risk.reason });
      });
      const affectedPaths = Object.freeze([...new Set(results.flatMap(result => result.affectedPaths))]);
      let analysis: Analysis = results.some(r => r.analysis !== 'unknown') ? 'recognized' : 'unknown';
      if (analysis === 'recognized' && (parsed.incomplete || results.some(r => r.analysis === 'partial'))) analysis = 'partial';
      const action: Action = Object.freeze({
        actionId: randomUUID(), operation: 'execute_command', command, cwd,
        affectedPaths, analysis, risks: Object.freeze(risks),
      });
      const forbidden = risks.filter(risk => config.policies[risk.category] === 'block');
      if (forbidden.length) return Object.freeze({ decision: 'block', code: 'POLICY_BLOCK', action, reason: forbidden.map(r => r.reason).join(' ') });
      return Object.freeze({ decision: 'ask', action, reason: 'Требуется решение пользователя.' });
    } catch { return reject('CHECK_FAILED', 'Не удалось завершить проверку действия. Выполнение запрещено.'); }
  }
  return Object.freeze({ config, check });
}

function freezeParsed(parsed: import('./types.js').ParsedCommand) {
  return Object.freeze({ incomplete: parsed.incomplete, segments: Object.freeze(parsed.segments.map(segment => Object.freeze(segment.map(token => Object.freeze({ ...token }))))) });
}
