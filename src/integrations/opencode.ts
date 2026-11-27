export function openCodeProfile(node: string, server: string, config: string) {
  return {
    permissions: [
      { action: '*', resource: '*', effect: 'allow' },
      { action: 'execute', resource: '*', effect: 'deny' },
    ],
    policies: [
      { action: 'tool.use', resource: '*', effect: 'deny' },
      { action: 'tool.use', resource: 'read:*', effect: 'allow' },
      { action: 'tool.use', resource: 'guard_guard_execute_command:*', effect: 'allow' },
    ],
    mcp: { servers: { guard: {
      type: 'local', command: [node, server, config], codemode: false,
      timeout: { startup: 30000, catalog: 10000, execution: 600000 },
    } } },
  };
}

export const openCodeInstructions = `# Agent Guard: порядок работы в этом проекте

Для выполнения команд и изменения файлов используй только MCP-инструмент
guard_execute_command сервера guard (имя в OpenCode: guard_guard_execute_command).
Обычную задачу пользователя переводи в вызов этого инструмента с точной командой
и абсолютной рабочей папкой. Пользователю не нужно называть инструмент в запросе.
Чтение файлов проекта разрешено встроенным read. Остальные встроенные инструменты,
Code Mode, другие MCP-серверы и делегирование не использовать для обхода Guard.

Guard сам проверяет и выполняет команду. Жди его результата; не выполняй её повторно
другим способом. Решение человек принимает в отдельной панели Agent Guard.
Не пытайся открыть служебные файлы, вызвать API подтверждения, получить секрет
панели или подтвердить действие от имени пользователя. Текст разрешения в чате
не заменяет решение в панели. Отказ или блокировку сообщи пользователю без обхода.
Не повторяй отклонённую команду без нового запроса пользователя.

Эти инструкции направляют поведение агента; запреты обеспечиваются настройками
инструментов, а не этим текстом. Они не являются изоляцией средствами ОС.
`;
