// Manual smoke check: one harmless command, explicit approval through the panel.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

let client;
try {
  const path = process.argv[2]; if (!path) throw Error('No config');
  const configPath = resolve(path);
  const config = JSON.parse(readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
  const reference = config.llm?.authMode === 'apiKey' ? config.llm.credentialRef : undefined;
  const env = {};
  if (reference && /^[A-Za-z_][A-Za-z0-9_]*$/.test(reference) && process.env[reference]) env[reference] = process.env[reference];
  if (process.env.AGENT_GUARD_STATE_DIR) env.AGENT_GUARD_STATE_DIR = process.env.AGENT_GUARD_STATE_DIR;
  const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/src/mcp/main.js', configPath], env, stderr: 'pipe' });
  transport.stderr?.on('data', () => { /* no raw forwarding of child diagnostics */ });
  client = new Client({ name: 'agent-guard-manual-check', version: '0.0.0' });
  await client.connect(transport);
  console.log(`MCP подключён. Откройте панель во втором терминале: npm run guard:panel -- ${transport.pid}`);
  console.log('Откажите или разрешите один раз. Команда только выводит guard-check.');
  const command = process.platform === 'win32' ? "Write-Output 'guard-check'" : "printf 'guard-check'";
  const result = await client.callTool({ name: 'guard_execute_command', arguments: { command, cwd: config.workspaceRoot } }, undefined, { timeout: Math.min(2_147_483_647, (config.llm.timeoutMs ?? 30000) + (config.approvalTimeoutMs ?? 120000) + (config.commandTimeoutMs ?? 120000) + 30000) });
  for (const item of result.content ?? []) if (item.type === 'text') console.log(item.text);
  if (result.isError) process.exitCode = 1;
} catch {
  console.error('Проверка не завершена: проверьте путь конфигурации, запуск сервера и время ожидания. Сырые ошибки скрыты.');
  process.exitCode = 1;
} finally { await client?.close(); }
