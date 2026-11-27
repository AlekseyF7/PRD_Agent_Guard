import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ShellProfile } from '../execution/types.js';
import type { createExecutionService } from '../execution/service.js';
export function createMcpServer(service: ReturnType<typeof createExecutionService>, shell: ShellProfile) {
  const server = new McpServer({ name: 'agent-guard', version: '0.0.0' });
  server.registerTool('guard_execute_command', {
    description: `Оболочка: ${shell}. Проверяет команду, показывает объяснение и ждёт разового решения человека в отдельной панели Agent Guard. Сам выполняет только разрешённую команду. Не передавайте approved или согласие агента.`,
    inputSchema: z.object({ command: z.string(), cwd: z.string() }).strict(),
    annotations: { destructiveHint: true, readOnlyHint: false, idempotentHint: false, openWorldHint: true },
  }, async (input, extra) => {
    const result = await service.run(input, extra.signal);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], isError: result.status !== 'completed' || result.exitCode !== 0 };
  });
  server.server.onclose = () => service.close();
  return server;
}
