import { randomUUID } from 'node:crypto';
import type { UserDecision } from '../core/types.js';
import type { ApprovalRequest } from '../execution/types.js';
export function createApprovalBroker() {
  let pending: { request: ApprovalRequest; nonce: string; resolve: (decision: UserDecision) => void; cleanup: () => void } | undefined;
  return {
    request(request: ApprovalRequest, signal: AbortSignal): Promise<UserDecision> {
      if (pending || signal.aborted) return Promise.reject(new Error('Approval unavailable'));
      return new Promise((resolve, reject) => {
        const abort = () => { if (pending?.request.action.actionId === request.action.actionId) pending = undefined; reject(new Error('Approval cancelled')); };
        signal.addEventListener('abort', abort, { once: true });
        pending = { request, nonce: randomUUID(), resolve, cleanup: () => signal.removeEventListener('abort', abort) };
      });
    },
    state: () => pending ? { ...pending.request, nonce: pending.nonce } : undefined,
    submit(actionId: unknown, nonce: unknown, outcome: unknown): boolean {
      if (!pending || actionId !== pending.request.action.actionId || nonce !== pending.nonce) return false;
      const expected = pending.request.explanation.status === 'available' ? 'allow_once' : 'allow_once_without_explanation';
      if (outcome !== 'deny' && outcome !== expected) return false;
      const current = pending; pending = undefined; current.cleanup();
      current.resolve(Object.freeze({ actionId: current.request.action.actionId, outcome: outcome as UserDecision['outcome'] }));
      return true;
    },
  };
}
