// Explicit diagnostic only: sends one synthetic action, never executes a command.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore, DEFAULT_POLICIES } from '../dist/src/core/index.js';
import { createLlmClient, LlmConfigError, PROMPT_VERSION } from '../dist/src/llm/index.js';

let directory;
try {
  const authMode = process.env.AGENT_GUARD_LLM_AUTH_MODE ?? 'apiKey';
  const client = createLlmClient({
    baseURL: process.env.AGENT_GUARD_LLM_BASE_URL,
    model: process.env.AGENT_GUARD_LLM_MODEL,
    timeoutMs: Number(process.env.AGENT_GUARD_LLM_TIMEOUT_MS ?? '30000'),
    authMode,
    ...(authMode === 'apiKey' ? { credentialRef: 'AGENT_GUARD_LLM_API_KEY' } : {}),
  });
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'agent-guard-llm-')));
  const core = createCore({ workspaceRoot: directory, mode: 'paranoid', policies: DEFAULT_POLICIES });
  const checked = core.check({ command: 'rm -- sample.txt', cwd: directory });
  if (checked.decision !== 'ask') throw new Error('Unexpected synthetic check');
  const started = performance.now();
  const result = await client.explain(checked.action);
  // No endpoint, key, environment or raw provider response in this output.
  console.log(JSON.stringify({ promptVersion: PROMPT_VERSION, elapsedMs: Math.round(performance.now() - started), result }, null, 2));
  if (result.status !== 'available') process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ status: 'unavailable', code: error instanceof LlmConfigError ? error.code : 'CHECK_ERROR' }));
  process.exitCode = 1;
} finally {
  if (directory) rmSync(directory, { recursive: true, force: true });
}
