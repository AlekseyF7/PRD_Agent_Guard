import { createVSIX } from '@vscode/vsce';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
mkdirSync('artifacts', { recursive: true });
await createVSIX({ cwd: resolve('extensions/vscode'), packagePath: resolve('artifacts/agent-guard-panel-0.0.1.vsix'), dependencies: false, allowMissingRepository: true, skipLicense: true });
