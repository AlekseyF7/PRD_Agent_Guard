import { canonicalTarget, isInside } from '../core/paths.js';
import { gitRule } from '../core/rules.js';
import type { ParsedCommand, Risk, RiskRule, Token } from '../core/types.js';

export function parsePowerShell(command: string): ParsedCommand {
  const segments: Token[][] = []; let tokens: Token[] = [];
  let value = '', active = false, literal = true, incomplete = false;
  let quote: string | undefined;
  const flush = () => { if (active) tokens.push({ value, literal }); value = ''; active = false; literal = true; };
  const split = () => { flush(); if (tokens.length) segments.push(tokens); tokens = []; };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote === "'") {
      if (c === "'" && command[i + 1] === "'") { value += "'"; i++; }
      else if (c === "'") quote = undefined; else value += c;
      continue;
    }
    if (c === '`') { const next = command[++i]; if (next) { value += next; active = true; literal = false; incomplete = true; } else incomplete = true; continue; }
    if (quote === '"') {
      if (c === '"') quote = undefined; else { value += c; if (c === '$') { literal = false; incomplete = true; } }
      continue;
    }
    if (c === "'" || c === '"') { quote = c; active = true; continue; }
    if (c === '#' && !active) { while (i < command.length && command[i] !== '\n') i++; incomplete = true; split(); continue; }
    if (';|&(){}\n'.includes(c)) { incomplete = true; split(); continue; }
    if (' \t\r'.includes(c)) { flush(); continue; }
    value += c; active = true;
    if ('$*?[],<>'.includes(c)) { literal = false; incomplete = true; }
  }
  if (quote) { literal = false; incomplete = true; }
  split(); return { segments, incomplete };
}
export const powerShellRule: RiskRule = {
  id: 'powershell.risk',
  analyze(context) {
    const parsed = parsePowerShell(context.command);
    const git = gitRule.analyze({ ...context, parsed });
    const risks: Risk[] = [...git.risks]; const paths = new Set<string>();
    for (const segment of parsed.segments) {
      const name = segment[0]?.literal ? segment[0].value.toLowerCase() : '';
      if (!['remove-item', 'rm', 'ri', 'del', 'erase', 'rd', 'rmdir'].includes(name)) continue;
      risks.push({ ruleId: 'powershell.remove-item', category: 'file_delete', reason: 'PowerShell-команда может удалить файлы или каталоги.' });
      for (const token of segment.slice(1)) {
        if (!token.literal || token.value.startsWith('-') || parsed.segments.length > 1) continue;
        const path = canonicalTarget(context.cwd, token.value);
        if (!path) continue;
        paths.add(path);
        if (!isInside(context.workspaceRoot, path)) risks.push({ ruleId: 'powershell.outside-target', category: 'outside_workspace', reason: 'Известная цель удаления находится вне рабочей области.' });
      }
    }
    return { risks, affectedPaths: [...paths], analysis: risks.length ? 'partial' : 'unknown' };
  },
};
// The POSIX rules must not reinterpret PowerShell backslashes or quoting.
export const noPosixParsing = (): ParsedCommand => ({ segments: [], incomplete: true });
