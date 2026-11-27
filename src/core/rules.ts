import { isAbsolute } from 'node:path';
import { canonicalTarget, isInside } from './paths.js';
import type { Risk, RiskRule, RuleResult, Token } from './types.js';

const empty = (): RuleResult => ({ risks: [], affectedPaths: [], analysis: 'unknown' });
const isCommand = (token: Token | undefined, name: string) =>
  token?.literal === true && [name, `/bin/${name}`, `/usr/bin/${name}`].includes(token.value);

export const deletionRule: RiskRule = {
  id: 'shell.rm',
  analyze({ parsed, cwd, workspaceRoot }) {
    const risks: Risk[] = [];
    const paths = new Set<string>();
    let recognized = false;
    let partial = false;
    for (const segment of parsed.segments) {
      if (!isCommand(segment[0], 'rm')) continue;
      recognized = true;
      risks.push({ ruleId: 'shell.rm', category: 'file_delete', reason: 'Команда rm может удалить файлы или каталоги.' });
      let options = true;
      for (const token of segment.slice(1)) {
        if (!token.literal) { partial = true; continue; }
        const arg = token.value;
        if (options && arg === '--') { options = false; continue; }
        if (options && arg.startsWith('-') && arg !== '-') {
          if (!/^-[frRdiIv]+$/.test(arg) && !['--force', '--recursive', '--dir', '--interactive', '--verbose'].includes(arg)) partial = true;
          continue;
        }
        if (!arg || (parsed.segments.length > 1 && !isAbsolute(arg))) { partial = true; continue; }
        const target = canonicalTarget(cwd, arg);
        if (!target) { partial = true; continue; }
        paths.add(target);
        if (!isInside(workspaceRoot, target)) risks.push({
          ruleId: 'path.outside-target', category: 'outside_workspace',
          reason: 'Известная цель удаления находится вне рабочей области.',
        });
      }
    }
    return { risks, affectedPaths: [...paths], analysis: recognized ? (partial ? 'partial' : 'recognized') : 'unknown' };
  },
};

export const gitRule: RiskRule = {
  id: 'git.risk',
  analyze({ parsed }) {
    const risks: Risk[] = [];
    for (const segment of parsed.segments) {
      if (!isCommand(segment[0], 'git') || !segment[1]?.literal) continue;
      const operation = segment[1].value;
      const allArgs = segment.slice(2).filter(t => t.literal).map(t => t.value);
      const endOptions = allArgs.indexOf('--');
      const args = endOptions < 0 ? allArgs : allArgs.slice(0, endOptions);
      if (operation === 'reset' && args.some(a => a === '--hard' || a.startsWith('--hard='))) risks.push({
        ruleId: 'git.reset-hard', category: 'git_destructive', reason: 'Git reset --hard может уничтожить незакоммиченные изменения.',
      });
      if (operation === 'clean') {
        let force = false;
        let dryRun = false;
        const operands = segment.slice(2);
        for (let i = 0; i < operands.length; i++) {
          const token = operands[i]!;
          if (!token.literal) continue;
          const arg = token.value;
          if (arg === '--') break;
          // Exclusion patterns are values, even when they look like flags.
          if (arg === '-e' || arg === '--exclude') { i++; continue; }
          if (arg.startsWith('--exclude=') || (arg.startsWith('-e') && arg.length > 2)) continue;
          if (arg === '--force' || (/^-[fdxXinq]+$/.test(arg) && arg.includes('f'))) force = true;
          if (arg === '--dry-run' || (/^-[fdxXinq]+$/.test(arg) && arg.includes('n'))) dryRun = true;
        }
        if (force && !dryRun) risks.push({
          ruleId: 'git.clean-force', category: 'git_destructive', reason: 'Git clean с force может удалить неотслеживаемые файлы.',
        });
      }
      if (operation === 'push' && args.some(a => a === '--force' || a === '--force-with-lease' || a.startsWith('--force-with-lease=') || (/^-[A-Za-z]+$/.test(a) && a.includes('f')))) risks.push({
        ruleId: 'git.push-force', category: 'git_force_push', reason: 'Принудительный push может перезаписать удалённую историю.',
      });
    }
    // Git changes depend on repository state; affected files are not enumerated.
    return { risks, affectedPaths: [], analysis: risks.length ? 'partial' : 'unknown' };
  },
};

export const outsideDirectoryRule: RiskRule = {
  id: 'path.outside-cwd',
  analyze({ cwd, workspaceRoot }) {
    return isInside(workspaceRoot, cwd) ? empty() : {
      risks: [{ ruleId: 'path.outside-cwd', category: 'outside_workspace', reason: 'Рабочая папка находится вне рабочей области.' }],
      affectedPaths: [], analysis: 'partial',
    };
  },
};

export const DEFAULT_RULES: readonly RiskRule[] = Object.freeze([
  Object.freeze(deletionRule), Object.freeze(gitRule), Object.freeze(outsideDirectoryRule),
]);
