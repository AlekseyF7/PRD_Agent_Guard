import { build } from 'esbuild';
await build({ entryPoints: ['extensions/vscode/src/extension.ts'], outfile: 'extensions/vscode/out/extension.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node18', external: ['vscode'], minify: false, sourcemap: false, legalComments: 'none' });
