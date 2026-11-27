import type { Action, CheckResult, Explanation, UserDecision } from '../core/types.js';
export type ShellProfile = 'posix-sh' | 'windows-powershell';
export interface ProcessResult {
  readonly status: 'completed' | 'execution_error' | 'unknown';
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly code?: 'SPAWN_ERROR' | 'TIMEOUT' | 'CANCELLED' | 'PROCESS_SIGNAL' | 'RESULT_UNKNOWN';
}
export type ExecutionResult = (ProcessResult & { readonly actionId: string }) |
  { readonly status: 'not_executed'; readonly code: string; readonly message: string; readonly actionId?: string };
export interface ApprovalRequest { readonly action: Action; readonly explanation: Explanation; readonly shell: ShellProfile }
export interface ExecutionDependencies {
  readonly check: (input: unknown) => CheckResult;
  readonly explain: (action: Action) => Promise<Explanation>;
  readonly approve: (request: ApprovalRequest, signal: AbortSignal) => Promise<UserDecision>;
  readonly execute: (action: Action, signal: AbortSignal) => Promise<ProcessResult>;
  readonly shell: ShellProfile;
  readonly approvalTimeoutMs: number;
}
export interface AttemptView {
  readonly phase: 'explaining' | 'waiting' | 'executing';
  readonly action: Action;
  readonly shell: ShellProfile;
  readonly explanation?: Explanation;
}
