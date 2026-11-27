import { existsSync, readFileSync, realpathSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeConfigSchema } from '../dist/src/mcp/config.js';
import { openCodeInstructions, openCodeProfile } from '../dist/src/integrations/opencode.js';

const created = [];
try {
  if (process.argv.length !== 4) throw Error('args');
  const project = realpathSync(process.argv[2]);
  const configPath = realpathSync(process.argv[3]);
  const config = runtimeConfigSchema.parse(JSON.parse(readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '')));
  if (realpathSync(config.workspaceRoot) !== project) throw Error('workspace');
  const configTarget = join(project, 'opencode.json'); const instructionsTarget = join(project, 'AGENTS.md');
  if ([configTarget, instructionsTarget, join(project, '.opencode.json')].some(existsSync)) throw Error('existing');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const server = join(root, 'dist/src/mcp/main.js');
  const profile = openCodeProfile(process.execPath, server, configPath);
  for (const [path, contents] of [[configTarget, JSON.stringify(profile, null, 2) + '\n'], [instructionsTarget, openCodeInstructions]]) {
    writeFileSync(path, contents, { flag: 'wx', mode: 0o600 }); created.push(path);
  }
  console.log('Созданы opencode.json и AGENTS.md. Запускайте opencode --standalone из выбранной папки.');
  console.log('Ключ задаётся окружением до запуска; генератор его не читает и не записывает.');
} catch {
  for (const path of created) { try { unlinkSync(path); } catch { /* report failure without raw paths/config */ } }
  console.error('Профиль не создан. Укажите существующие папку и guard.json с тем же workspaceRoot. Существующие opencode.json, .opencode.json и AGENTS.md не перезаписываются.');
  process.exitCode = 1;
}
