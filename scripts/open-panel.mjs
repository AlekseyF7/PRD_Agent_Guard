import { readFileSync, readdirSync } from 'node:fs';
import { join, win32 } from 'node:path';
import { execFile } from 'node:child_process';
import { panelRecordDirectory } from '../dist/src/mcp/panel-record.js';
try {
  const directory = panelRecordDirectory();
  const records = [];
  for (const name of readdirSync(directory).filter(n => /^\d+\.json$/.test(n))) {
    try { const record = JSON.parse(readFileSync(join(directory, name), 'utf8')); process.kill(record.pid, 0); records.push(record); } catch { /* stale record */ }
  }
  const id = process.argv[2];
  const selected = id ? records.find(r => String(r.pid) === id) : records.length === 1 ? records[0] : undefined;
  if (!selected) { console.error('Укажите PID активного сервера: npm run guard:panel -- <PID>. Активные PID: '+records.map(r => r.pid).join(', ')); process.exitCode = 1; }
  else {
    const url = new URL(selected.url);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !/^#token=[0-9a-f]{64}$/.test(url.hash)) throw Error('Invalid record');
    const file = process.platform === 'darwin' ? '/usr/bin/open' : process.platform === 'win32' ? win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'rundll32.exe') : 'xdg-open';
    const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url.href] : [url.href];
    execFile(file, args, { windowsHide: true }, error => { if (error) { console.error('Не удалось открыть панель. Проверьте браузер и запуск MCP-сервера.'); process.exitCode = 1; } });
  }
} catch { console.error('Нет доступной панели. Сначала запустите MCP-сервер с конфигурацией.'); process.exitCode = 1; }
