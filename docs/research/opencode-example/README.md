# OpenCode MCP Example (Agent Guard — spec 001)

## Статус

| Компонент | Версия | Статус |
|-----------|--------|--------|
| Node.js | v26.13.1 | ✓ Установлен |
| LM Studio | port 1234 | ✓ qwen3.6-35b-a3b |
| OpenCode Desktop | — | ✓ Установлен |

## Файлы

```
opencode-example/
├── mcp-server.js      # MCP-сервер (test_echo, guard_check_status, guard_execute_command)
├── test-client.js     # Тестовый клиент для проверки сервера
├── README.md          # Этот файл
└── EXPERIMENTS.md     # Руководство по экспериментам E1-E6 (в папке выше)
```

## Быстрый старт

### 1. Проверка MCP-сервера (локально)
```powershell
cd docs\research\opencode-example
node test-client.js
# Ожидаемый результат: 7 ok, 0 errors
```

### 2. Подключение к OpenCode Desktop
Файл `.opencode.json` в корне проекта уже содержит конфигурацию MCP-сервера.

Откройте OpenCode Desktop в папке `C:\zmy\rep\PRD_Agent_Guard` и проверьте:
- Сервер "guard" отображается в разделе MCP Servers
- Статус: пустое поле (сервер не подключается на Windows)
- Инструменты доступны: test_echo, guard_check_status, guard_execute_command (проверено через прямой JSON-RPC)

### 3. Проведение экспериментов E1-E6
Следуйте инструкциям в `EXPERIMENTS.md`

## Формат конфигурации MCP (из схемы OpenCode)

```jsonc
{
  "mcp": {
    "servers": {
      "guard": {
        "type": "local",
        "command": ["node", "/absolute/path/to/server.js"],
        "cwd": "/working/dir",
        "environment": {},
        "disabled": false,
        "codemode": false,
        "timeout": {
          "startup": 30000,
          "catalog": 10000,
          "execution": 60000
        },
        "protocol": "auto",
        "pool": false
      }
    }
  }
}
```

## Формат разрешений (permissions)

```jsonc
{
  "permissions": [
    { "action": "shell", "resource": "*", "effect": "deny" },
    { "action": "file_edit", "resource": "*", "effect": "ask" }
  ]
}
```

## Формат политик (policies)

```jsonc
{
  "policies": [
    { "action": "tool.use", "resource": "shell:*", "effect": "deny" },
    { "action": "mcp.use", "resource": "guard", "effect": "allow" }
  ]
}
```
