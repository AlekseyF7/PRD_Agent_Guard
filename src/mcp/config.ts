import { z } from 'zod';
import { DEFAULT_POLICIES } from '../core/index.js';
const policy = z.enum(['ask', 'block']);
export const runtimeConfigSchema = z.object({
  workspaceRoot: z.string().min(1),
  policies: z.object({ file_delete: policy, git_destructive: policy, git_force_push: policy, outside_workspace: policy }).strict().default(DEFAULT_POLICIES),
  llm: z.object({ baseURL: z.string(), model: z.string(), timeoutMs: z.number().positive().max(2_147_483_647), authMode: z.enum(['apiKey', 'none']), credentialRef: z.string().optional() }).strict(),
  commandTimeoutMs: z.number().int().positive().max(2_147_483_647).default(120000),
  approvalTimeoutMs: z.number().int().positive().max(2_147_483_647).default(120000),
  outputLimitBytes: z.number().int().positive().max(65536).default(65536),
  uiPort: z.number().int().min(0).max(65535).default(0),
}).strict();
export type RuntimeConfig = z.input<typeof runtimeConfigSchema>;
