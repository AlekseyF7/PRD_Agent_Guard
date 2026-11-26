import { lstatSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, parse, relative, sep } from 'node:path';

export function canonicalDirectory(value: unknown): string | undefined {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) return;
  try {
    const canonical = realpathSync(value);
    return statSync(canonical).isDirectory() ? canonical : undefined;
  } catch { return; }
}

export function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

// Не применять path.resolve ко всей строке до realpath: link/.. зависит от symlink.
export function canonicalTarget(cwd: string, operand: string): string | undefined {
  const absolute = isAbsolute(operand) ? operand : `${cwd}${sep}${operand}`;
  let current = parse(absolute).root;
  const parts = absolute.slice(current.length).split(sep).filter(Boolean);
  let missing = false;
  for (const part of parts) {
    if (missing && (part === '.' || part === '..')) return;
    const next = join(current, part);
    if (missing) { current = next; continue; }
    try { current = realpathSync(next); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return;
      // Dangling links are ambiguous; they are not ordinary missing path components.
      try {
        lstatSync(next);
        return;
      } catch (entryError) {
        if ((entryError as NodeJS.ErrnoException).code !== 'ENOENT') return;
      }
      current = next;
      missing = true;
    }
  }
  return current;
}
