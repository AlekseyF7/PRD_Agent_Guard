import { randomBytes } from 'node:crypto';
import { createCore } from '../core/index.js';
import { createLlmClient, environmentKeySource } from '../llm/index.js';
import type { LlmDependencies } from '../llm/types.js';
import { createApprovalBroker } from '../approval/broker.js';
import { startApprovalHttp } from '../approval/http.js';
import { createExecutionService } from '../execution/service.js';
import { createProcessExecutor } from '../execution/process.js';
import { noPosixParsing, powerShellRule } from '../execution/powershell.js';
import { runtimeConfigSchema } from './config.js';
import { createMcpServer } from './server.js';

export async function createRuntime(input: unknown, llmDependencies: LlmDependencies = {}) {
  const config = runtimeConfigSchema.parse(input);
  const shell = process.platform === 'win32' ? 'windows-powershell' as const : 'posix-sh' as const;
  const coreConfig = { workspaceRoot: config.workspaceRoot, mode: 'paranoid', policies: config.policies };
  const core = shell === 'windows-powershell' ? createCore(coreConfig, [powerShellRule], noPosixParsing) : createCore(coreConfig);
  const token = randomBytes(32).toString('hex');
  const secrets = new Set([token]);
  const source = llmDependencies.resolveApiKey ?? environmentKeySource();
  const redact = (text: string) => { for (const key of secrets) text = text.replaceAll(key, '[REDACTED]'); return text; };
  const llm = createLlmClient(config.llm, { ...llmDependencies, resolveApiKey: async reference => { const key = await source(reference); if (key) secrets.add(key); return key; } });
  const broker = createApprovalBroker();
  const service = createExecutionService({
    check: core.check, explain: llm.explain, approve: broker.request, shell,
    approvalTimeoutMs: config.approvalTimeoutMs,
    execute: createProcessExecutor({ shell, timeoutMs: config.commandTimeoutMs, outputLimitBytes: config.outputLimitBytes, redact }),
  });
  const panel = await startApprovalHttp({ token, port: config.uiPort,
    state: () => ({ workspaceRoot: core.config.workspaceRoot, ...service.state(), pending: broker.state() }),
    decide: data => broker.submit(data.actionId, data.nonce, data.outcome), cancel: service.cancel,
  });
  const server = createMcpServer(service, shell);
  let closing = false;
  return { server, service, panel, shell,
    async close() { if (closing) return; closing = true; service.close(); await server.close(); await panel.close(); },
  };
}
