# Конфигурации OpenCode для тестирования MCP-сервера

Эти файлы использовались для экспериментов по подключению MCP-сервера `agent-guard-mcp` к OpenCode v2.x.

## Что такое mcp-server.js?

**mcp-server.js** — это минимальный сервер, реализующий протокол MCP (Model Context Protocol). Он создан в папке [`opencode-example/`](../opencode-example/) для тестирования подключения OpenCode к внешним инструментам.

### Зачем он нужен?

OpenCode может подключать внешние инструменты через MCP-протокол. Наш сервер `mcp-server.js` имитирует реальный Agent Guard и предоставляет 3 инструмента:

| Инструмент | Назначение |
|-----------|-----------|
| `test_echo` | Возвращает переданный текст — для проверки связи |
| `guard_check_status` | Проверяет статус Agent Guard (pending команды, блокировки) |
| `guard_execute_command` | Симулирует выполнение команд с подтверждением пользователя |

### Как работает?

```bash
# Запуск сервера
node mcp-server.js

# OpenCode подключается через stdio pipe и отправляет JSON-RPC запросы:
# 1. initialize → получает список инструментов (tools/list)
# 2. tools/call → вызывает нужный инструмент с аргументами
```

Сервер работает независимо от LLM-провайдера — ему всё равно, какая модель запущена (LM Studio, OpenAI и т.д.).

## Файлы

### `.opencode.json` — полный рабочий конфиг

Содержит:
- **MCP-сервер** `guard` — подключение к `docs/research/opencode-example/mcp-server.js` через stdio
- **Провайдер** `local` — LM Studio на `http://localhost:1234/v1`

Использовался в экспериментах E1-E6 для проверки подключения и вызова инструментов.

### `opencode.json` — упрощённая версия

Содержит только конфигурацию MCP-сервера (без providers). Создан как референс для тех, кому нужен только MCP без провайдера LLM.

## Статус экспериментов

| Эксперимент | Статус | Результат |
|-------------|--------|-----------|
| E1: MCP подключение (CLI) | OK Завершён | Конфиг валиден, но CLI не подключается |
| E1: MCP подключение (Desktop) | WARN Частично | Видит сервер, статус пустой |
| E2a: Прямой JSON-RPC (pipe) | OK PASS | Echo работает, tools/list работает |
| E2b: test_echo через pipe | OK PASS | "Echo: Hello from Agent Guard" |
| E2c: OpenCode CLI --standalone | FAIL | MCP не загружается в standalone |
| E2d: OpenCode Desktop чат | FAIL | Сервер не подключается, инструменты недоступны |

## Примечания

- Оба файла содержат **абсолютные пути** к `mcp-server.js` — они актуальны только для этой машины (`C:\zmy\rep\PRD_Agent_Guard`)
- Для переноса на другую машину нужно обновить путь к `node.exe` и `mcp-server.js`
- Параметр `codemode: false` критичен для экспорта инструментов в каталог агента

## Где дальше искать информацию

- Результаты экспериментов: [`../EXPERIMENTS.md`](../EXPERIMENTS.md)
- Отчёт исследования: [`../opencode-research.md`](../opencode-research.md)
- MCP-сервер (исходный код): [`../opencode-example/mcp-server.js`](../opencode-example/mcp-server.js)

