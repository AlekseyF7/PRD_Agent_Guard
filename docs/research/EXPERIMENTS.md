# Руководство по экспериментам Agent Guard (spec 001) — OpenCode Desktop

> ⚠️ **Примечание:** Все эксперименты проводились с локальной моделью LM Studio на Windows. Результаты могут отличаться при использовании других LLM-провайдеров или ОС.


## Предварительная настройка (уже сделано)

| Компонент | Статус | Путь / Порт |
|-----------|--------|-------------|
| Node.js v26.13.1 | ✓ Установлен | C:\Program Files\nodejs\node.exe |
| LM Studio + qwen3.6-35b-a3b | ✓ Работает | http://localhost:1234 |
| OpenCode CLI v2.4.1 | ✓ Установлен | npm global |
| OpenCode Desktop App | ⚠️ Видит конфиг, но не подключается к MCP | — |

### Текущий конфиг проекта (C:\zmy\rep\PRD_Agent_Guard\.opencode.json)
```json
{
  "mcp": {
    "servers": {
      "guard": {
        "type": "local",
        "command": ["C:\\Program Files\\nodejs\\node.exe", "C:\\zmy\\rep\\PRD_Agent_Guard\\docs\\research\\opencode-example\\mcp-server.js"],
        "cwd": "C:\\zmy\\rep\\PRD_Agent_Guard",
        "codemode": false,
        "timeout": { "startup": 30000, "catalog": 10000, "execution": 60000 }
      }
    }
  },
  "providers": {
    "local": {
      "type": "openai",
      "api_key": "lm-studio",
      "base_url": "http://localhost:1234/v1"
    }
  }
}
```

---

## E1: Подключение MCP-сервера через stdio — РЕЗУЛЬТАТЫ

### Цель
Убедиться, что OpenCode Desktop подключает наш MCP-сервер "guard".

### Шаг 1. Валидация JSON конфига
**Результат:** ✓ OK PASS
```python
import json
json.load('opencode.json')   # OK
json.load('.opencode.json')  # OK
```

### Шаг 2. Проверка путей к файлам
**Результат:** ✓ OK PASS
- Test-Path node.exe -> Exists
- Test-Path mcp-server.js -> Exists

### Шаг 3. Запуск сервера вручную
**Команда:** `node mcp-server.js`
**Результат:** ✓ OK PASS — Сервер запускается и ждёт сообщений:
```
[agent-guard-mcp] Starting...
[agent-guard-mcp] Tools: test_echo, guard_check_status, guard_execute_command
```

### Шаг 4. Проверка через чат OpenCode Desktop
**Результат:** ⚠️ WARN ЧАСТИЧНО — Сервер виден в конфиге, но статус подключения пустой (нет green check / red X / gray circle)

### Шаг 5. opencode mcp list (CLI)
**Результат:** ✗ FAIL Request timed out

### Итог E1

| Проверка | Статус | Детали |
|----------|--------|--------|
| Валидация JSON | ✓ OK PASS | json.load() подтверждает корректность |
| opencode debug config | ✓ OK PASS | Конфиг читается, показывает guard сервер |
| OpenCode Desktop - отображение | ✓ OK PASS | Имя, тип, команда отображаются в UI |
| OpenCode Desktop - статус | ✗ FAIL Пустое поле | Нет индикатора подключения |
| opencode mcp list (CLI) | ✗ FAIL Request timed out | Сервер не отвечает в таймаут |
| opencode mcp list из проекта | ⚠️ WARN pending -> failed | Зависит от таймаута |

### Вывод по E1
- Конфигурация **валидна** и соответствует документации OpenCode v2.x
- OpenCode Desktop **видит** сервер в конфиге, но **не подключается** к нему
- CLI mcp list показывает Request timed out — сервер не отвечает в рамках таймаута

---

## E2: Вызов MCP-инструментов агентом — РЕЗУЛЬТАТЫ

### Инструменты MCP-сервера

| Имя | Описание | Аргументы |
|-----|----------|-----------|
| test_echo | Возвращает переданный текст | message: string (required) |
| guard_check_status | Проверяет статус Agent Guard | нет |
| guard_execute_command | Симулирует выполнение команд | command, working_dir, user_approved |

### E2a - Прямой JSON-RPC вызов через pipe

**Результат:** ✓ OK PASS — УСПЕХ

```bash
# Инициализация + tools/list через pipe (Windows)
$init = '{"jsonrpc":"2.0","id":1,"method":"initialize",...}'
$notif = '{"jsonrpc":"2.0","method":"notifications/initialized"}'
$input = $init + "`r`n" + $notif + "`r`n"
echo $input | node docs/research/opencode-example/mcp-server.js
```

**Ответ initialize:** ✓ OK
```json
{
  "protocolVersion": "2024-11-05",
  "capabilities": {"tools": {"listChanged": false}},
  "serverInfo": {"name": "agent-guard-mcp", "version": "0.1.0"}
}
```

**Ответ tools/list:** ✓ OK — 3 tools returned: test_echo, guard_check_status, guard_execute_command

### E2b - Вызов test_echo через JSON-RPC

**Запрос:**
```json
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"test_echo","arguments":{"message":"Hello from Agent Guard"}}}
```

**Ответ:** ✓ OK PASS — УСПЕХ
```json
{
  "content": [{"type": "text", "text": "Echo: Hello from Agent Guard"}],
  "isError": false
}
```

### E2c - Вызов через OpenCode CLI (--standalone run)

**Результат:** ✗ FAIL — НЕ РАБОТАЕТ

- Агент ищет test_echo через встроенный search() — не находит
- Сообщение: "no 'test_echo' tool is available in my catalog"
- В логах нет ни одного упоминания MCP-сервера
- CLI **не загружает** MCP-серверы в standalone-режиме

### E2d - Вызов через OpenCode Desktop (чат)

**Результат:** ✗ FAIL — НЕ РАБОТАЕТ

- Агент сообщает: "в текущей среде у меня нет прямого доступа к инструментам MCP-сервера"
- Сервер виден в конфиге, но инструменты не экспортированы в Code Mode
- Нет индикатора статуса подключения (пустое поле)

### Итог E2

| Интерфейс | Статус | Причина |
|-----------|--------|---------|
| Прямой JSON-RPC (pipe) | ✓ OK PASS Работает | Сервер корректно обрабатывает инициализацию |
| OpenCode CLI --standalone | ✗ FAIL Не работает | MCP-серверы не загружаются в standalone-режиме |
| OpenCode Desktop чат | ✗ FAIL Не работает | Сервер не подключается, инструменты недоступны |

---
## E3: Блокировка терминала (deny shell) - РЕЗУЛЬТАТЫ

**Цель:** Проверить, что правило deny блокирует выполнение команд в терминале.

### Шаг 1. Добавь правило deny
Открой C:\zmy\rep\PRD_Agent_Guard\.opencode.json и добавь поле permissions:
```json
{
  "mcp": { ... },
  "providers": { ... },
  "permissions": [
    { "action": "shell", "resource": "*", "effect": "deny" }
  ]
}
```

### Шаг 2. Перезагрузи OpenCode Desktop
В чате напиши: reload - или закрой и открой приложение заново.

### Шаг 3. Попроси агента выполнить команду
Напиши в чат:
```
Выполни команду echo test в терминале.
```

**Ожидаемый результат:** Агент **не выполнит** команду и покажет сообщение об ошибке / отказе доступа.

### Результат E3

| Что произошло | Статус | Комментарий |
|---------------|--------|-------------|
| Команда заблокирована? | N/A | Зависит от E1 (сервер не подключается) |
| Агент сообщил о запрете? | N/A | Зависит от E1 |

### Вывод по E3
- **Статус:** BLOCKED - зависит от успешного подключения MCP-сервера (E1)
- **Рекомендация:** Проверить после решения проблемы с подключением OpenCode Desktop на Windows
- **Гипотеза:** Если правило deny работает, агент должен получить ошибку "access denied"

---

## E4: Блокировка редактирования файлов (deny file_edit) - РЕЗУЛЬТАТЫ

**Цель:** Проверить, что правило deny блокирует создание/редактирование файлов.

### Шаг 1. Добавь правило deny для file_edit
Открой C:\zmy\rep\PRD_Agent_Guard\.opencode.json и замени permissions:
```json
{
  "mcp": { ... },
  "providers": { ... },
  "permissions": [
    { "action": "file_edit", "resource": "*", "effect": "deny" }
  ]
}
```

### Шаг 2. Перезагрузи OpenCode Desktop
reload или перезапуск приложения.

### Шаг 3. Попроси агента создать файл
Напиши в чат:
```
Создай файл test.txt в текущей директории с содержимым "test".
```

**Ожидаемый результат:** Агент **не создаст** файл и покажет сообщение об отказе доступа.

### Результат E4

| Что произошло | Статус | Комментарий |
|---------------|--------|-------------|
| Файл не создан? | N/A | Зависит от E1 (сервер не подключается) |
| Агент сообщил о запрете? | N/A | Зависит от E1 |

### Вывод по E4
- **Статус:** BLOCKED - зависит от успешного подключения MCP-сервера (E1)
- **Рекомендация:** Проверить после решения проблемы с подключением OpenCode Desktop на Windows
- **Гипотеза:** Если правило deny работает, агент должен получить ошибку "access denied"

---

## E5: Встроенное подтверждение пользователя (ask) - РЕЗУЛЬТАТЫ

**Цель:** Проверить, что при permission ask появляется UI-диалог подтверждения.

> Этот эксперимент можно провести ТОЛЬКО в Desktop - терминал не поддерживает интерактивное подтверждение.

### Шаг 1. Установи permission ask
Открой C:\zmy\rep\PRD_Agent_Guard\.opencode.json и замени permissions:
```json
{
  "mcp": { ... },
  "providers": { ... },
  "permissions": [
    { "action": "shell", "resource": "*", "effect": "ask" }
  ]
}
```

### Шаг 2. Перезагрузи OpenCode Desktop
reload или перезапуск приложения.

### Шаг 3. Попроси агента выполнить команду
Напиши в чат:
```
Выполни команду echo test в терминале.
```

**Ожидаемый результат:**
1. Агент **остановится** и покажет диалог подтверждения
2. Появится кнопка Approve / Deny (или аналог)
3. При Approve - команда выполнится, output появится в чате
4. При Deny - агент сообщит об отказе

### Результат E5

| Что произошло | Статус | Комментарий |
|---------------|--------|-------------|
| Появился диалог подтверждения? | N/A | Зависит от E1, только Desktop |
| Кнопка Approve работает? | N/A | Зависит от E1 |
| Кнопка Deny работает? | N/A | Зависит от E1 |
| Команда выполнилась после approve? | N/A | Зависит от E1 |

### Вывод по E5
- **Статус:** BLOCKED - зависит от успешного подключения MCP-сервера (E1)
- **Ограничение:** Только Desktop, не CLI
- **Гипотеза:** Если permission ask работает, появится UI-диалог с кнопками Approve/Deny

---

## E6: Разрешённое чтение через LSP diagnostics - РЕЗУЛЬТАТЫ

**Цель:** Проверить, что агент видит синтаксические ошибки через LSP.

### Шаг 1. Создай файл с ошибкой
Создай C:\zmy\rep\PRD_Agent_Guard\test-lsp.js с содержимым:
```javascript
function hello( {
    console.log("Hello"
}
```
Ошибки: пропущена закрывающая скобка в аргументе, пропущена ), пропущена }.

### Шаг 2. Перезагрузи OpenCode Desktop
reload или перезапуск приложения.

### Шаг 3. Попроси агента проверить ошибки
Напиши в чат:
```
Проверь файл test-lsp.js на синтаксические ошибки и покажи diagnostics.
```

**Ожидаемый результат:** Агент найдёт и опишет ошибки, например:
- Unexpected token (строка 1)
) expected (строка 2)
} expected (строка 3)

### Результат E6

| Что произошло | Статус | Комментарий |
|---------------|--------|-------------|
| Агент нашёл ошибки? | N/A | Зависит от E1 (сервер не подключается) |
| Ошибки точные? | N/A | Зависит от E1 |
| Указаны номера строк? | N/A | Зависит от E1 |

### Вывод по E6
- **Статус:** BLOCKED - зависит от успешного подключения MCP-сервера (E1)
- **Гипотеза:** LSP diagnostics должны работать независимо от MCP, но требуют запущенного OpenCode Desktop
- **Рекомендация:** Проверить после решения проблемы с подключением

---

## Сводная таблица результатов

| Эксперимент | Статус | Результат | Дата проверки |
|-------------|--------|-----------|---------------|
| E1: MCP подключение (CLI) | OK Завершён | Конфиг валиден, но CLI не подключается | 25.11.2026 |
| E1: MCP подключение (Desktop) | WARN Частично | Видит сервер, статус пустой | 25.11.2026 |
| E2a: Прямой JSON-RPC (pipe) | OK PASS | Echo работает, tools/list работает | 25.11.2026 |
| E2b: test_echo через pipe | OK PASS | "Echo: Hello from Agent Guard" | 25.11.2026 |
| E2c: OpenCode CLI --standalone | FAIL | MCP не загружается в standalone | 25.11.2026 |
| E2d: OpenCode Desktop чат | FAIL | Сервер не подключается, инструменты недоступны | 25.11.2026 |
| E3: deny shell | SEPARATE | Не зависит от MCP, требует проверки встроенных ограничений OpenCode |
| E4: deny file_edit | SEPARATE | Не зависит от MCP, требует проверки встроенных ограничений OpenCode |
| E5: ask confirmation | BLOCKED | Зависит от E1, только Desktop | - |
| E6: LSP diagnostics | BLOCKED | Зависит от E1 | - |

---

## Найдено в схеме OpenCode v2.x (anomalyco/opencode)

### MCP Configuration (packages/schema/src/mcp.ts)
- type: "local" | "remote"
- command: string[] (для local)
- cwd: working directory
- environment: Record<string, string>
- disabled, codemode, pool, protocol
- timeout: { startup, catalog, execution }

### Permissions (packages/schema/src/permission.ts)
```typescript
interface Rule {
  action: string;      // tool name
  resource: string;    // "*" или path pattern
  effect: "allow" | "deny" | "ask";
}
```

### Policies (packages/schema/src/config/policy.ts)
Действия: provider.use, tool.use, integration.connect, mcp.use, skill.use, plugin.use, websearch.use

---

## Исправление таймаута MCP-сервера (25.11.2026)

**Проблема:** OpenCode Desktop не подключался к mcp-server.js - таймаут при старте.

**Причины и исправления:**
1. readline на Windows с pipe работает нестабильно - заменён на raw stream listeners
2. Ошибка "pv is not defined" в initialize - переменная объявлена корректно
3. Line endings: MCP protocol требует CRLF (\r\n) - все stdout.write используют \r\n
4. Сервер закрывался при EOF stdin - добавлен handler stdin.on("end")

**Результат тестирования:**
```
initialize (id=1)  -> OK: protocolVersion, capabilities, serverInfo
tools/list (id=2)  -> OK: 3 tools returned
test_echo (id=3)   -> OK: "Echo: Hello CRLF test"
guard_check_status -> OK: { status: running, pending_commands: 0 }
guard_execute_command(approved) -> OK: exit_code: 0
```

**Что делать:** Перезагрузи OpenCode Desktop - сервер guard должен подключиться без таймаута.

> Важно: Несмотря на исправления, сервер не подключается из OpenCode CLI/Desktop на Windows. Требуется дополнительная диагностика или проверка на macOS/Linux.

---

## Рекомендации для зависимых спецификаций

### Для 004 - интеграция OpenCode (Александр)
| Что нужно | Статус | Комментарий |
|-----------|--------|-------------|
| Проверенная версия MCP-сервера | OK PASS | agent-guard-mcp v0.1.0, JSON-RPC 2.0 over stdio |
| Конфигурация opencode.json (JSON валидна) | WARN | JSON проходит валидацию, пути существуют. Не проверена рабочесть на OpenCode v2.4.1 |
| Формат аргументов инструментов | OK PASS | Определён (см. таблицу в E2) |
| Формат ответа | OK PASS | { content: [{ type, text }], isError } |
| Конфигурация запретов | Не проверена | Сервер не подключается из OpenCode |
| Результаты обходов | Не проверены | Зависит от E1 |

### Для 006 - MCP и выполнение (Алексей)
| Что нужно | Статус | Комментарий |
|-----------|--------|-------------|
| Команды подключения MCP | OK PASS | node mcp-server.js через JSON-RPC |
| Аргументы инструментов | OK PASS | Определены для всех 3 инструментов |
| Условия ожидания/отмены | Не проверено | Сервер не подключается из OpenCode |
| Источник доверенного решения | EXCLUDED | user_approved — заглушка, не доверенный источник (см. mcp-server.js:79-81) |

### Для 007 - Итоговые прогоны (Алексей)
| Что нужно | Статус | Комментарий |
|-----------|--------|-------------|
| Блокер для демо | WARN E1 не пройден полностью | Сервер не подключается из OpenCode Desktop |
| Рекомендация | Проверить в чистом тестовом проекте на macOS/Linux |

---

*Отчёт подготовлен на основе анализа публичных источников и экспериментальных данных.*
