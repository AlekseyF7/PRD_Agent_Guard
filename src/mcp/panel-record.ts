import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
export function panelRecordDirectory(): string {
  return process.env.AGENT_GUARD_STATE_DIR ?? (process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'AgentGuard', 'instances')
    : join(homedir(), '.config', 'agent-guard', 'instances'));
}
export function writePanelRecord(url: string, workspaceRoot: string) {
  const directory = panelRecordDirectory(); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${process.pid}.json`);
  writeFileSync(path, JSON.stringify({ pid: process.pid, url, workspaceRoot }), { mode: 0o600, flag: 'wx' });
  return () => { try { unlinkSync(path); } catch { /* already removed */ } };
}
