import { spawn, execFile, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { win32 } from 'node:path';
import type { Action } from '../core/types.js';
import type { ProcessResult, ShellProfile } from './types.js';

export const SYSTEM_ENV_KEYS = ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'APPDATA', 'LOCALAPPDATA'] as const;
export function commandEnvironment(input: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed = new Set(SYSTEM_ENV_KEYS.map(k => k.toUpperCase()));
  return Object.fromEntries(Object.entries(input).filter(([key, value]) => allowed.has(key.toUpperCase()) && value !== undefined));
}
export function shellCommand(command: string, profile: ShellProfile, systemRoot = process.env.SystemRoot ?? 'C:\\Windows') {
  return profile === 'posix-sh' ? { file: '/bin/sh', args: ['-c', command] }
    : { file: win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')] };
}
export function createProcessExecutor(options: { shell: ShellProfile; timeoutMs: number; outputLimitBytes: number; redact?: (text: string) => string }) {
  if (![options.timeoutMs, options.outputLimitBytes].every(n => Number.isSafeInteger(n) && n > 0 && n <= 2_147_483_647)) throw new Error('Invalid execution limits');
  return (action: Action, signal: AbortSignal): Promise<ProcessResult> => new Promise(resolve => {
    const blank = { stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false, exitCode: null };
    if (signal.aborted) { resolve({ ...blank, status: 'execution_error', code: 'CANCELLED' }); return; }
    const spec = shellCommand(action.command, options.shell);
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try { child = spawn(spec.file, spec.args, { cwd: action.cwd, env: commandEnvironment(), stdio: ['ignore', 'pipe', 'pipe'], detached: options.shell === 'posix-sh', windowsHide: true }); }
    catch { resolve({ ...blank, status: 'execution_error', code: 'SPAWN_ERROR' }); return; }
    const out: Buffer[] = [], err: Buffer[] = [];
    let outSize = 0, errSize = 0, outCut = false, errCut = false;
    let cause: 'TIMEOUT' | 'CANCELLED' | undefined;
    let finished = false;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const redact = options.redact ?? ((text: string) => text);
    function finish(result: ProcessResult) {
      if (finished) return; finished = true;
      clearTimeout(timer); if (watchdog) clearTimeout(watchdog);
      signal.removeEventListener('abort', cancel);
      resolve(result);
    }
    const text = () => ({ stdout: redact(Buffer.concat(out).toString('utf8')), stderr: redact(Buffer.concat(err).toString('utf8')), stdoutTruncated: outCut, stderrTruncated: errCut });
    function kill() {
      if (options.shell === 'posix-sh') { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
      else if (child.pid) {
        const executable = win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
        execFile(executable, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, () => {});
      }
    }
    function stop(code: 'TIMEOUT' | 'CANCELLED') {
      if (finished || cause) return; cause = code; kill();
      watchdog = setTimeout(() => finish({ ...text(), status: 'unknown', code: 'RESULT_UNKNOWN', exitCode: null }), 6000);
    }
    const cancel = () => stop('CANCELLED');
    const timer = setTimeout(() => stop('TIMEOUT'), options.timeoutMs);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    child.stdout.on('data', (chunk: Buffer) => { const remaining = Math.max(0, options.outputLimitBytes - outSize); if (remaining) out.push(chunk.subarray(0, remaining)); outSize += Math.min(chunk.length, remaining); outCut ||= chunk.length > remaining; });
    child.stderr.on('data', (chunk: Buffer) => { const remaining = Math.max(0, options.outputLimitBytes - errSize); if (remaining) err.push(chunk.subarray(0, remaining)); errSize += Math.min(chunk.length, remaining); errCut ||= chunk.length > remaining; });
    child.on('error', () => finish({ ...text(), status: 'execution_error', code: 'SPAWN_ERROR', exitCode: null }));
    child.on('close', (exitCode) => {
      if (options.shell === 'posix-sh') { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* group already gone */ } }
      finish({ ...text(), status: cause || exitCode === null ? 'execution_error' : 'completed', ...(cause ? { code: cause } : exitCode === null ? { code: 'PROCESS_SIGNAL' as const } : {}), exitCode });
    });
  });
}
