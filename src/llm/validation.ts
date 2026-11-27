import { isAbsolute } from 'node:path';
import { POLICY_CATEGORIES } from '../core/types.js';
import type { Action, Risk } from '../core/types.js';
import type { LlmSettings } from './types.js';

export class LlmConfigError extends Error {
  readonly code = 'INVALID_CONFIG';
  constructor() { super('Некорректные настройки подключения LLM.'); this.name = 'LlmConfigError'; }
}
function record(input: unknown, required: readonly string[], optional: readonly string[] = []): input is Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return false;
  if (![Object.prototype, null].includes(Object.getPrototypeOf(input))) return false;
  const keys = Reflect.ownKeys(input);
  return required.every(key => keys.includes(key)) && keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    return typeof key === 'string' && [...required, ...optional].includes(key) && !!descriptor && 'value' in descriptor && descriptor.enumerable;
  });
}
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && !value.includes('\0');
const path = (value: unknown): value is string => text(value) && isAbsolute(value);

export function parseSettings(input: unknown): LlmSettings {
  try {
    if (!record(input, ['baseURL', 'model', 'timeoutMs', 'authMode'], ['credentialRef'])) throw new LlmConfigError();
    if (!text(input.baseURL) || !text(input.model) || input.model.trim() !== input.model) throw new LlmConfigError();
    const url = new URL(input.baseURL);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new LlmConfigError();
    // Reject whitespace rather than quietly altering the destination.
    if (/\s/.test(input.baseURL)) throw new LlmConfigError();
    if (typeof input.timeoutMs !== 'number' || !Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0 || input.timeoutMs > 2_147_483_647) throw new LlmConfigError();
    if (input.authMode !== 'apiKey' && input.authMode !== 'none') throw new LlmConfigError();
    if (input.authMode === 'apiKey' && !text(input.credentialRef)) throw new LlmConfigError();
    if (input.authMode === 'none' && 'credentialRef' in input) throw new LlmConfigError();
    const base: LlmSettings = { baseURL: url.href.replace(/\/+$/, ''), model: input.model, timeoutMs: input.timeoutMs, authMode: input.authMode };
    return Object.freeze(input.authMode === 'apiKey' ? { ...base, credentialRef: input.credentialRef as string } : base);
  } catch { throw new LlmConfigError(); }
}

export function copyAction(input: unknown): Action | undefined {
  try {
    if (!record(input, ['actionId', 'operation', 'command', 'cwd', 'affectedPaths', 'analysis', 'risks'])) return;
    if (typeof input.actionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.actionId)) return;
    if (input.operation !== 'execute_command' || !text(input.command) || !path(input.cwd)) return;
    if (!['recognized', 'partial', 'unknown'].includes(input.analysis as string)) return;
    if (!Array.isArray(input.affectedPaths) || ![...input.affectedPaths].every(path) || !Array.isArray(input.risks)) return;
    const risks: Risk[] = [];
    for (const risk of input.risks) {
      if (!record(risk, ['ruleId', 'category', 'reason']) || !text(risk.ruleId) || !text(risk.reason) || !POLICY_CATEGORIES.includes(risk.category as Risk['category'])) return;
      risks.push(Object.freeze({ ruleId: risk.ruleId, category: risk.category as Risk['category'], reason: risk.reason }));
    }
    return Object.freeze({ actionId: input.actionId, operation: 'execute_command', command: input.command, cwd: input.cwd,
      affectedPaths: Object.freeze([...input.affectedPaths]), analysis: input.analysis as Action['analysis'], risks: Object.freeze(risks) });
  } catch { return; }
}

export function correlationId(input: unknown): string {
  try {
    const value = Object.getOwnPropertyDescriptor(input, 'actionId')?.value;
    return typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value) ? value : '';
  } catch { return ''; }
}
