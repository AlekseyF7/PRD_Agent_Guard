import { createVSIX } from '@vscode/vsce';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
mkdirSync('artifacts', { recursive: true });
const manifest = JSON.parse(readFileSync('extensions/vscode/package.json', 'utf8'));
await createVSIX({ cwd: resolve('extensions/vscode'), packagePath: resolve(`artifacts/${manifest.name}-${manifest.version}.vsix`), dependencies: false, allowMissingRepository: true, skipLicense: true });
