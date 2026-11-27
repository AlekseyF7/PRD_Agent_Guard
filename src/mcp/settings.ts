import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, realpathSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { runtimeConfigSchema } from './config.js';

export const settingsSchema = z.object({
  policies: runtimeConfigSchema.shape.policies.removeDefault(),
  llm: runtimeConfigSchema.shape.llm,
}).strict();
export type UserSettings = z.infer<typeof settingsSchema>;
export interface SettingsStore { load(): unknown; save(settings: UserSettings): void }
export function createSettingsStore(workspaceRoot: string, directory?: string): SettingsStore {
  const canonical = realpathSync(workspaceRoot);
  const id = createHash('sha256').update(process.platform === 'win32' ? canonical.toLowerCase() : canonical).digest('hex');
  const folder = directory ?? (process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'AgentGuard', 'settings')
    : join(homedir(), '.config', 'agent-guard', 'settings'));
  const file = join(folder, `${id}.json`);
  return {
    load() {
      try {
        const stat = lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw Error('Invalid settings');
        return settingsSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    },
    save(input) {
      const settings = settingsSchema.parse(input);
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      const temporary = join(folder, `${id}.${randomUUID()}.tmp`);
      try {
        writeFileSync(temporary, JSON.stringify(settings, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        renameSync(temporary, file);
      } finally { try { unlinkSync(temporary); } catch { /* already renamed */ } }
    },
  };
}
