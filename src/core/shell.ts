import type { ParsedCommand, Token } from './types.js';

// Bounded lexer, not a shell interpreter. Operators retain separate simple parts,
// but always lower completeness. Expansions never become literal file targets.
export function parseCommand(command: string): ParsedCommand {
  const segments: Token[][] = [];
  let tokens: Token[] = [];
  let value = '';
  let active = false;
  let literal = true;
  let incomplete = false;
  let redirected = false;
  let quote: "'" | '"' | undefined;
  const flush = () => {
    if (active) tokens.push({ value, literal: literal && !redirected });
    value = ''; active = false; literal = true;
  };
  const split = () => { flush(); if (tokens.length) segments.push(tokens); tokens = []; redirected = false; };
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (quote === "'") {
      if (char === "'") quote = undefined;
      else value += char;
      continue;
    }
    if (char === '\\') {
      const next = command[i + 1];
      if (next === undefined) { incomplete = true; literal = false; break; }
      if (quote === '"' && !['$', '`', '"', '\\', '\n'].includes(next)) {
        value += char; continue;
      }
      i++;
      if (next !== '\n') { value += next; active = true; }
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = undefined;
      else {
        value += char;
        if (char === '$' || char === '`') { literal = false; incomplete = true; }
      }
      continue;
    }
    if (char === "'" || char === '"') { quote = char; active = true; continue; }
    if (char === '#' && !active) {
      while (i < command.length && command[i] !== '\n') i++;
      if (i < command.length) { incomplete = true; split(); }
      continue;
    }
    if (char === '<' || char === '>') { incomplete = true; flush(); redirected = true; continue; }
    if (';|&()\n'.includes(char)) {
      incomplete = true;
      split();
      continue;
    }
    if (char === ' ' || char === '\t') { flush(); continue; }
    active = true;
    value += char;
    if ('$`*?[]{}'.includes(char) || (char === '~' && value.length === 1)) {
      literal = false; incomplete = true;
    }
  }
  if (quote) { incomplete = true; literal = false; }
  split();
  return { segments, incomplete };
}
