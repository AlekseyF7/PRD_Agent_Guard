import { readFileSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createRuntime } from './runtime.js';
import { writePanelRecord } from './panel-record.js';
import { createSettingsStore } from './settings.js';

let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
let removeRecord: (() => void) | undefined;
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  removeRecord?.(); await runtime?.close();
}
try {
  const path = process.argv[2] ?? process.env.AGENT_GUARD_CONFIG;
  if (!path) throw new Error('No config');
  const config: unknown = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  runtime = await createRuntime(config, {}, createSettingsStore((config as { workspaceRoot: string }).workspaceRoot));
  removeRecord = writePanelRecord(runtime.panel.url, (config as { workspaceRoot: string }).workspaceRoot);
  runtime.server.server.onclose = () => { void stop(); };
  process.once('SIGTERM', () => { void stop(); });
  process.once('SIGINT', () => { void stop(); });
  process.stdin.once('end', () => { void stop(); });
  await runtime.server.connect(new StdioServerTransport());
} catch {
  // Never log raw config, exception, API credential or the private panel URL.
  process.stderr.write('Agent Guard: startup failed; check configuration and local permissions.\n');
  process.exitCode = 1; await stop();
}
