import { lstatSync } from 'node:fs';
import type { Action, Explanation } from '../core/types.js';
import type { AttemptView, ExecutionDependencies, ExecutionResult } from './types.js';

function footprint(action: Action): string {
  return JSON.stringify([action.cwd, ...action.affectedPaths].map(path => {
    try { const s = lstatSync(path); return [path, s.dev, s.ino, s.mode, s.size, s.mtimeMs]; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [path, 'missing']; throw error; }
  }));
}
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('cancelled'));
  return new Promise((resolve, reject) => {
    const cancel = () => reject(new Error('cancelled'));
    signal.addEventListener('abort', cancel, { once: true });
    promise.then(value => { signal.removeEventListener('abort', cancel); resolve(value); }, error => { signal.removeEventListener('abort', cancel); reject(error); });
  });
}
export function createExecutionService(initial: ExecutionDependencies) {
  let deps = initial;
  let active: AbortController | undefined;
  let view: AttemptView | undefined;
  let last: ExecutionResult | undefined;
  let closed = false;
  const no = (code: string, message: string, actionId?: string): ExecutionResult => Object.freeze({ status: 'not_executed', code, message, ...(actionId ? { actionId } : {}) });
  async function run(input: unknown, external?: AbortSignal): Promise<ExecutionResult> {
    if (closed) return no('CLOSED', 'Сервер завершает работу.');
    if (active) return no('BUSY', 'Другая попытка ещё активна; повторите позже.');
    const current = deps;
    const controller = new AbortController(); active = controller;
    const signal = external ? AbortSignal.any([controller.signal, external]) : controller.signal;
    let action: Action | undefined;
    try {
      if (signal.aborted) return no('CANCELLED', 'Попытка отменена до запуска.');
      const checked = current.check(input);
      if (checked.decision === 'block') return no(checked.code, checked.reason, 'action' in checked ? checked.action.actionId : undefined);
      action = checked.action;
      const before = footprint(action);
      view = Object.freeze({ phase: 'explaining', action, shell: current.shell });
      let explanation: Explanation;
      try { explanation = await abortable(current.explain(action), signal); }
      catch {
        if (signal.aborted) return no('CANCELLED', 'Попытка отменена.', action.actionId);
        explanation = { actionId: action.actionId, status: 'unavailable', error: { code: 'EXPLANATION_ERROR', message: 'Объяснение недоступно.' } };
      }
      if (signal.aborted) return no('CANCELLED', 'Попытка отменена.', action.actionId);
      if (explanation.actionId !== action.actionId) return no('ACTION_MISMATCH', 'Ответ относится к другому действию.', action.actionId);
      // Snapshot the explanation too; integrations cannot mutate an in-flight card.
      explanation = explanation.status === 'available'
        ? Object.freeze({ actionId: action.actionId, status: 'available', text: explanation.text })
        : Object.freeze({ actionId: action.actionId, status: 'unavailable', error: Object.freeze({ ...explanation.error }) });
      if (explanation.status === 'available' && !explanation.text.trim()) return no('INVALID_EXPLANATION', 'Некорректный ответ объяснения.', action.actionId);
      view = Object.freeze({ phase: 'waiting', action, shell: current.shell, explanation });
      const waitController = new AbortController();
      const waitSignal = AbortSignal.any([signal, waitController.signal]);
      const timer = setTimeout(() => waitController.abort(), current.approvalTimeoutMs);
      let decision;
      try { decision = await abortable(current.approve({ action, explanation, shell: current.shell }, waitSignal), waitSignal); }
      catch { return no(signal.aborted ? 'CANCELLED' : waitController.signal.aborted ? 'NO_ANSWER' : 'APPROVAL_ERROR', 'Разрешение не получено.', action.actionId); }
      finally { clearTimeout(timer); waitController.abort(); }
      if (signal.aborted) return no('CANCELLED', 'Попытка отменена.', action.actionId);
      if (decision.actionId !== action.actionId) return no('ACTION_MISMATCH', 'Решение относится к другому действию.', action.actionId);
      const expected = explanation.status === 'available' ? 'allow_once' : 'allow_once_without_explanation';
      if (decision.outcome !== expected) return no(decision.outcome === 'deny' ? 'DENIED' : 'NO_APPROVAL', 'Действие не разрешено.', action.actionId);
      const rechecked = current.check({ command: action.command, cwd: action.cwd });
      if (rechecked.decision !== 'ask' || rechecked.action.command !== action.command || rechecked.action.cwd !== action.cwd || JSON.stringify(rechecked.action.affectedPaths) !== JSON.stringify(action.affectedPaths) || footprint(action) !== before) return no('STALE_ACTION', 'Условия изменились; требуется новая проверка.', action.actionId);
      signal.throwIfAborted();
      // No await between the final check and invocation: only one transition to execution.
      view = Object.freeze({ phase: 'executing', action, shell: current.shell, explanation });
      const result = await current.execute(action, signal);
      return Object.freeze({ ...result, actionId: action.actionId });
    } catch {
      return view?.phase === 'executing'
        ? { status: 'unknown', code: 'RESULT_UNKNOWN', actionId: action!.actionId, exitCode: null, stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false }
        : no(signal.aborted ? 'CANCELLED' : 'CHECK_FAILED', 'Проверка или подтверждение не завершены.', action?.actionId);
    } finally { view = undefined; active = undefined; }
  }
  return {
    async run(input: unknown, signal?: AbortSignal) {
      const result = await run(input, signal);
      if (!(result.status === 'not_executed' && result.code === 'BUSY')) last = result;
      return result;
    },
    state: () => ({ active: view, last }),
    cancel: () => active?.abort(),
    replace(next: ExecutionDependencies) { active?.abort(); deps = next; },
    close() { closed = true; active?.abort(); },
  };
}
