export const POLICY_CATEGORIES = [
  'file_delete', 'git_destructive', 'git_force_push', 'outside_workspace',
] as const;
export type PolicyCategory = typeof POLICY_CATEGORIES[number];
export type Policy = 'ask' | 'block';
export type Analysis = 'recognized' | 'partial' | 'unknown';
export interface CoreConfig {
  readonly workspaceRoot: string;
  readonly mode: 'paranoid';
  readonly policies: Readonly<Record<PolicyCategory, Policy>>;
}
export interface Risk {
  readonly ruleId: string;
  readonly category: PolicyCategory;
  readonly reason: string;
}
export interface Action {
  readonly actionId: string;
  readonly operation: 'execute_command';
  readonly command: string;
  readonly cwd: string;
  readonly affectedPaths: readonly string[];
  readonly analysis: Analysis;
  readonly risks: readonly Risk[];
}
export type CheckError = 'INVALID_REQUEST' | 'INVALID_COMMAND' | 'INVALID_CWD' | 'CHECK_FAILED';
export type CheckResult =
  | { readonly decision: 'ask'; readonly action: Action; readonly reason: string }
  | { readonly decision: 'block'; readonly code: 'POLICY_BLOCK'; readonly action: Action; readonly reason: string }
  | { readonly decision: 'block'; readonly code: CheckError; readonly reason: string };
// allow зарезервирован контрактом для Fast; Paranoid его не возвращает.
export type Decision = 'allow' | 'ask' | 'block';
export type Explanation =
  | { readonly actionId: string; readonly status: 'available'; readonly text: string }
  | { readonly actionId: string; readonly status: 'unavailable'; readonly error: { readonly code: string; readonly message: string } };
export interface UserDecision {
  readonly actionId: string;
  readonly outcome: 'allow_once' | 'allow_once_without_explanation' | 'deny' | 'cancel' | 'no_answer' | 'error';
}
export interface Token { readonly value: string; readonly literal: boolean }
export interface ParsedCommand {
  readonly segments: readonly (readonly Token[])[];
  readonly incomplete: boolean;
}
export interface RuleContext {
  readonly command: string;
  readonly parsed: ParsedCommand;
  readonly cwd: string;
  readonly workspaceRoot: string;
}
export interface RuleResult {
  readonly risks: readonly Risk[];
  readonly affectedPaths: readonly string[];
  readonly analysis: Analysis;
}
export interface RiskRule {
  readonly id: string;
  readonly analyze: (context: RuleContext) => RuleResult;
}
