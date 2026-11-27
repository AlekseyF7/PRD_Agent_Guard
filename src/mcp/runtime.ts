import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { createCore } from '../core/index.js';
import { createLlmClient, environmentKeySource } from '../llm/index.js';
import type { LlmDependencies } from '../llm/types.js';
import { createApprovalBroker } from '../approval/broker.js';
import { startApprovalHttp } from '../approval/http.js';
import { createExecutionService } from '../execution/service.js';
import { createProcessExecutor } from '../execution/process.js';
import { noPosixParsing, powerShellRule } from '../execution/powershell.js';
import { runtimeConfigSchema } from './config.js';
import { settingsSchema, type SettingsStore } from './settings.js';
import { createMcpServer } from './server.js';

export async function createRuntime(input: unknown, llmDependencies: LlmDependencies = {}, store?: SettingsStore) {
  const initial = runtimeConfigSchema.parse(input);
  const loaded = store?.load();
  let config = runtimeConfigSchema.parse({ ...initial, ...(loaded === undefined ? {} : settingsSchema.parse(loaded)) });
  let configured = loaded !== undefined;
  const shell = process.platform === 'win32' ? 'windows-powershell' as const : 'posix-sh' as const;
  const token = randomBytes(32).toString('hex');
  const secrets = new Set([token]);
  const keys = new Map<string, string | undefined>();
  const waiters = new Map<string, Set<(key: string | undefined) => void>>();
  const environment = llmDependencies.resolveApiKey ?? environmentKeySource();
  const redact = (text: string) => { for (const key of secrets) text = text.replaceAll(key, '[REDACTED]'); return text; };
  const safe = <T>(value: T): T => JSON.parse(JSON.stringify(value, (_key, item: unknown) => typeof item === 'string' ? redact(item) : item)) as T;
  const source = async (reference: string) => {
    let key: string | undefined;
    if (reference.startsWith('vscode:')) {
      if (keys.has(reference)) key = keys.get(reference);
      else key = await new Promise<string | undefined>(resolve => {
        const finish = (value: string | undefined) => { clearTimeout(timer); waiters.get(reference)?.delete(finish); resolve(value); };
        const timer = setTimeout(() => finish(undefined), 10000);
        const pending = waiters.get(reference) ?? new Set(); pending.add(finish); waiters.set(reference, pending);
      });
    } else key = await environment(reference);
    if (reference.startsWith('vscode:') && reference !== config.llm.credentialRef) key = undefined;
    if (key) secrets.add(key);
    return key;
  };
  const broker = createApprovalBroker();
  const components = (candidate: typeof config) => {
    if (candidate.llm.authMode === 'apiKey' && !/^(?:vscode:[0-9a-f-]{36}|[A-Za-z_][A-Za-z0-9_]*)$/.test(candidate.llm.credentialRef ?? '')) throw Error('Invalid reference');
    const coreConfig = { workspaceRoot: candidate.workspaceRoot, mode: 'paranoid', policies: candidate.policies };
    const core = shell === 'windows-powershell' ? createCore(coreConfig, [powerShellRule], noPosixParsing) : createCore(coreConfig);
    const llm = createLlmClient(candidate.llm, { ...llmDependencies, resolveApiKey: source });
    return { core, llm, dependencies: {
      check: core.check, explain: llm.explain, approve: broker.request, shell,
      approvalTimeoutMs: candidate.approvalTimeoutMs,
      execute: createProcessExecutor({ shell, timeoutMs: candidate.commandTimeoutMs, outputLimitBytes: candidate.outputLimitBytes, redact }),
    } };
  };
  const service = createExecutionService(components(config).dependencies);
  const metadata = () => ({ configured, settings: { policies: config.policies, llm: config.llm },
    hasKey: config.llm.authMode === 'apiKey' && (config.llm.credentialRef?.startsWith('vscode:') ? !!keys.get(config.llm.credentialRef) : false) });
  const admin = async (path: string, input?: unknown) => {
    if (path === '/api/history') return safe(service.history());
    if (path === '/api/settings' && input === undefined) return metadata();
    if (path === '/api/key') {
      const data = z.object({ credentialRef: z.string(), key: z.string().max(4096).optional() }).strict().parse(input);
      if (data.credentialRef !== config.llm.credentialRef || !/^vscode:[0-9a-f-]{36}$/.test(data.credentialRef)) throw Error('Invalid reference');
      if (keys.has(data.credentialRef) && keys.get(data.credentialRef) !== (data.key || undefined) && service.state().active?.phase === 'executing') throw Error('Wait for execution');
      if (data.key) secrets.add(data.key);
      if (keys.has(data.credentialRef) && keys.get(data.credentialRef) !== (data.key || undefined)) service.cancel();
      keys.set(data.credentialRef, data.key || undefined);
      for (const finish of waiters.get(data.credentialRef) ?? []) finish(data.key || undefined);
      return { ok: true };
    }
    if (path === '/api/connection-check') {
      z.object({}).strict().parse(input);
      const { core, llm } = components(config);
      const checked = core.check({ command: shell === 'posix-sh' ? "printf 'guard-connection-check'" : "Write-Output 'guard-connection-check'", cwd: config.workspaceRoot });
      if (checked.decision !== 'ask') throw Error('Synthetic action unavailable');
      const result = await llm.explain(checked.action);
      return safe({ ok: result.status === 'available', ...(result.status === 'unavailable' ? { message: result.error.message, code: result.error.code } : { message: 'Подключение работает: объяснение получено, команда не запускалась.' }) });
    }
    if (path === '/api/settings') {
      const data = z.object({ settings: settingsSchema, confirmKeyReuse: z.boolean().optional() }).strict().parse(input);
      const serialized = JSON.stringify(data.settings);
      if ([...secrets].some(secret => serialized.includes(secret))) throw Error('Secret in settings');
      if (service.state().active?.phase === 'executing') throw Error('Wait for execution');
      const llm = data.settings.llm;
      if (llm.authMode === 'apiKey' && !/^(?:vscode:[0-9a-f-]{36}|[A-Za-z_][A-Za-z0-9_]*)$/.test(llm.credentialRef ?? '')) throw Error('Invalid reference');
      if (llm.authMode === 'apiKey' && llm.baseURL !== config.llm.baseURL && llm.credentialRef === config.llm.credentialRef && !data.confirmKeyReuse) throw Error('Confirm credential for new address');
      const candidate = runtimeConfigSchema.parse({ ...config, ...data.settings });
      const next = components(candidate); // Validate everything before saving/cancelling.
      store?.save(data.settings);
      const previousReference = config.llm.credentialRef;
      service.replace(next.dependencies); config = candidate; configured = true;
      if (previousReference && previousReference !== config.llm.credentialRef) {
        keys.delete(previousReference);
        for (const finish of waiters.get(previousReference) ?? []) finish(undefined);
      }
      return metadata();
    }
    throw Error('Unsupported request');
  };
  const panel = await startApprovalHttp({ token, port: config.uiPort,
    state: () => safe({ workspaceRoot: config.workspaceRoot, ...service.state(), pending: broker.state(), configured,
      ...(config.llm.credentialRef?.startsWith('vscode:') && !keys.has(config.llm.credentialRef) ? { credentialNeeded: config.llm.credentialRef } : {}) }),
    decide: data => broker.submit(data.actionId, data.nonce, data.outcome), cancel: service.cancel, admin,
  });
  const server = createMcpServer(service, shell);
  let closing = false;
  return { server, service, panel, shell,
    async close() {
      if (closing) return; closing = true;
      for (const pending of waiters.values()) for (const finish of pending) finish(undefined);
      keys.clear(); service.close(); await server.close(); await panel.close();
    },
  };
}
