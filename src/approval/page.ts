import type { Action } from '../core/types.js';
import type { ApprovalRequest, AttemptView, ExecutionResult } from '../execution/types.js';
type Mode = 'browser' | 'vscode';
interface UiState { workspaceRoot: string; active?: AttemptView; pending?: ApprovalRequest & { nonce: string }; last?: ExecutionResult }

// Kept self-contained: its compiled function body is shared by browser and Webview.
function panelClient(mode: Mode) {
  type Bridge = { postMessage(message: unknown): void };
  const bridge = mode === 'vscode' ? (window as unknown as { acquireVsCodeApi(): Bridge }).acquireVsCodeApi() : undefined;
  const calls = new Map<number, { resolve(value: UiState): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  let serial = 0;
  if (bridge) window.addEventListener('message', event => {
    const message = event.data;
    if (!message || message.type !== 'guard-response' || !Number.isSafeInteger(message.id)) return;
    const call = calls.get(message.id); if (!call) return;
    clearTimeout(call.timer); calls.delete(message.id);
    if (message.ok) call.resolve(message.data); else call.reject(new Error('Связь с сервером недоступна.'));
  });
  const fromLink = mode === 'browser' ? new URLSearchParams(location.hash.slice(1)).get('token') : null;
  if (fromLink) { sessionStorage.setItem('guard-token', fromLink); history.replaceState(null, '', location.pathname); }
  const token = mode === 'browser' ? sessionStorage.getItem('guard-token') : null;
  let pending: UiState['pending']; let lastCard: AttemptView | undefined; let latest: UiState | undefined;
  let sending = false; let refreshing = false;
  const element = (id: string) => document.getElementById(id)!;
  const put = (id: string, text: string) => { element(id).textContent = text; };
  const button = (id: string) => element(id) as HTMLButtonElement;
  function status(label: string, tone: string) { put('status', label); element('status').dataset.tone = tone; }
  function richText(target: HTMLElement, text: string) {
    target.replaceChildren(); let list: HTMLUListElement | undefined;
    function inline(parent: HTMLElement, value: string) {
      const pattern = /(\*\*[^*\n]+\*\*|`[^`\n]+`)/g; let start = 0;
      for (const match of value.matchAll(pattern)) {
        parent.append(document.createTextNode(value.slice(start, match.index)));
        const node = document.createElement(match[0].startsWith('**') ? 'strong' : 'code');
        node.textContent = match[0].startsWith('**') ? match[0].slice(2, -2) : match[0].slice(1, -1);
        parent.append(node); start = match.index! + match[0].length;
      }
      parent.append(document.createTextNode(value.slice(start)));
    }
    for (const raw of text.split('\n')) {
      const line = raw.trim(); if (!line) { list = undefined; continue; }
      if (/^[-*]\s+/.test(line)) {
        if (!list) { list = document.createElement('ul'); target.append(list); }
        const item = document.createElement('li'); inline(item, line.replace(/^[-*]\s+/, '')); list.append(item);
      } else {
        list = undefined; const p = document.createElement('p'); inline(p, line.replace(/^#{1,3}\s+/, '')); target.append(p);
      }
    }
  }
  async function api(path: string, body?: unknown): Promise<UiState> {
    if (bridge) return new Promise((resolve, reject) => {
      const id = ++serial;
      const timer = setTimeout(() => { calls.delete(id); reject(new Error('Нет ответа сервера.')); }, 10000);
      calls.set(id, { resolve, reject, timer }); bridge.postMessage({ type: 'guard-request', id, path, ...(body !== undefined ? { body } : {}) });
    });
    const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + (token ?? ''), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('Запрос отклонён или решение устарело.');
    return response.json();
  }
  function resultLabel(result: ExecutionResult): { text: string; tone: string } {
    if (result.status === 'completed') return result.exitCode === 0 ? { text: 'Выполнено', tone: 'success' } : { text: 'Команда завершилась с ошибкой', tone: 'error' };
    if (result.status === 'not_executed') {
      if (result.code === 'DENIED') return { text: 'Отклонено пользователем — команда не запускалась', tone: 'denied' };
      if (result.code === 'POLICY_BLOCK') return { text: 'Заблокировано политикой', tone: 'error' };
      return { text: 'Не выполнено', tone: 'warning' };
    }
    return result.status === 'unknown' ? { text: 'Результат неизвестен', tone: 'warning' } : { text: 'Ошибка исполнения', tone: 'error' };
  }
  function renderResult(result?: ExecutionResult) {
    element('result-detail').hidden = !result;
    if (!result) { put('result-summary', 'Пока нет результатов'); return; }
    const label = resultLabel(result); put('result-summary', label.text); element('result-section').dataset.tone = label.tone;
    put('result-id', 'Действие: ' + (result.actionId ?? 'не создано'));
    const executed = result.status !== 'not_executed';
    put('result-message', executed ? 'Код завершения: ' + (result.exitCode ?? 'не получен') : result.message);
    const output = executed ? result.stdout : ''; const errors = executed ? result.stderr : '';
    element('stdout-wrap').hidden = !output; element('stderr-wrap').hidden = !errors;
    put('stdout', output); put('stderr', errors);
    put('truncated', executed && (result.stdoutTruncated || result.stderrTruncated) ? 'Вывод сокращён по установленному лимиту.' : '');
    put('technical', JSON.stringify(result, null, 2));
  }
  function render(state: UiState) {
    latest = state; put('error', ''); put('workspace', state.workspaceRoot);
    if (state.active) lastCard = state.active;
    const card = state.active ?? (state.last?.actionId === lastCard?.action.actionId ? lastCard : undefined);
    pending = state.pending;
    if (state.active) status({ explaining: 'Получаем объяснение', waiting: 'Нужно ваше решение', executing: 'Выполняется…' }[state.active.phase], state.active.phase === 'waiting' ? 'waiting' : 'running');
    else if (state.last) { const label = resultLabel(state.last); status(label.text, label.tone); }
    else status('Готов к работе', 'neutral');
    put('heading', state.active ? 'Действие агента' : card ? 'Последнее действие' : 'Ожидание действия');
    element('action-content').hidden = !card;
    if (card) {
      put('shell', 'Оболочка: ' + card.shell); put('command', card.action.command); put('cwd', 'Рабочая папка: ' + card.action.cwd);
      put('risk-summary', card.action.risks.length ? card.action.risks.map(r => r.reason).join('\n') : 'Правила не выявили известных рисков. В режиме Paranoid всё равно требуется решение.');
      put('paths', card.action.affectedPaths.length ? 'Известные цели:\n' + card.action.affectedPaths.join('\n') : 'Список затрагиваемых файлов не определён.');
      put('analysis', card.action.analysis === 'recognized' ? 'Команда разобрана в пределах поддерживаемых правил.' : 'Анализ неполный: отсутствие найденного риска не гарантирует безопасность.');
      richText(element('explanation'), card.explanation ? card.explanation.status === 'available' ? card.explanation.text : 'Объяснение недоступно. ' + card.explanation.error.message : 'Ожидание объяснения…');
    }
    element('buttons').hidden = !pending; button('allow').disabled = sending; button('deny').disabled = sending;
    button('allow').textContent = pending?.explanation.status === 'unavailable' ? 'Разрешить один раз без объяснения' : 'Разрешить один раз';
    element('cancel').hidden = !state.active;
    put('result-title', state.active && state.last ? 'Предыдущий результат' : 'Последний результат'); renderResult(state.last);
  }
  async function refresh() {
    if (refreshing) return; refreshing = true;
    try { render(await api('/api/state')); }
    catch {
      pending = undefined; element('buttons').hidden = true; element('cancel').hidden = true;
      status('Сервер остановлен или недоступен', 'offline');
      put('error', latest?.last ? 'Последний полученный результат сохранён ниже.' : 'Связь потеряна. Подтверждённого результата пока нет; проверьте процесс сервера.');
    } finally { refreshing = false; }
  }
  async function decide(deny: boolean) {
    if (!pending || sending) return; sending = true; button('allow').disabled = true; button('deny').disabled = true;
    status(deny ? 'Передаём отказ…' : 'Передаём разрешение…', 'running');
    try { await api('/api/decision', { actionId: pending.action.actionId, nonce: pending.nonce, outcome: deny ? 'deny' : pending.explanation.status === 'available' ? 'allow_once' : 'allow_once_without_explanation' }); }
    catch { put('error', 'Решение не принято: обновите состояние и попробуйте снова.'); }
    finally { sending = false; await refresh(); }
  }
  button('deny').onclick = () => { void decide(true); }; button('allow').onclick = () => { void decide(false); };
  button('cancel').onclick = async () => { try { await api('/api/cancel', {}); } finally { await refresh(); } };
  window.addEventListener('pagehide', () => {
    if (pending && mode === 'browser') void fetch('/api/cancel', { method: 'POST', headers: { Authorization: 'Bearer ' + (token ?? ''), 'Content-Type': 'application/json' }, body: '{}', keepalive: true }).catch(() => {});
  });
  void refresh(); setInterval(() => { void refresh(); }, 700);
}

export function approvalPage(nonce: string, mode: Mode = 'browser'): string {
  const policy = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src ${mode === 'vscode' ? "'none'" : "'self'"}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`;
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${policy}"><title>Agent Guard</title>
<style>
:root {
  color-scheme: dark;
  --bg: #0E0E14; --surface: #181924; --border: #2B2D3E;
  --accent: #7B3FE4; --cyan: #00ADEE; --mint: #42E3B4;
  --text: #F4F5F8; --muted: #9498B0; --danger: #FF94A8; --warning: #F3C781;
}
* { box-sizing: border-box; }
body {
  margin: 0; color: var(--text); font: 14px var(--vscode-font-family, system-ui);
  background: radial-gradient(ellipse at 15% 0%, #7B3FE416, transparent 55%), var(--bg);
}
main { max-width: 960px; margin: auto; padding: 28px 24px 24px; }
header { display: flex; gap: 20px; flex-wrap: wrap; justify-content: space-between; align-items: center; margin-bottom: 26px; }
.brand { display: flex; align-items: center; gap: 12px; }
.brand-mark {
  display: grid; place-items: center; flex-shrink: 0; width: 46px; height: 50px;
  border-radius: 14px; background: linear-gradient(145deg, #7B3FE435, #00ADEE12);
  border: 1px solid #7B3FE466; box-shadow: 0 0 30px #7B3FE418;
}
.brand-mark svg { width: 28px; height: 32px; }
.eyebrow, .section-label { display: block; margin: 0 0 6px; font-size: 10px; font-weight: 600; letter-spacing: .14em; color: var(--muted); }
h1 { margin: 0; font-size: 25px; line-height: 1.1; font-weight: 700; letter-spacing: -.04em; }
h2 { font-size: 19px; margin: 10px 0 18px; letter-spacing: -.025em; }
h3 { font-size: 12px; font-weight: 600; color: var(--muted); margin: 20px 0 10px; }
p, li { line-height: 1.65; }
#status {
  display: inline-flex; align-items: center; gap: 9px; max-width: 100%;
  border: 1px solid var(--border); border-radius: 24px; padding: 9px 13px;
  background: #181924CC; font-size: 12px; font-weight: 600; line-height: 1.45;
}
#status::before { content: ''; width: 7px; height: 7px; flex: 0 0 7px; border-radius: 50%; background: currentColor; box-shadow: 0 0 12px currentColor; }
section {
  position: relative; background: linear-gradient(145deg, #FFFFFF03, transparent 55%), var(--surface);
  border: 1px solid var(--border); border-radius: 16px; padding: 24px;
  margin: 18px 0; box-shadow: 0 10px 28px #00000020;
}
#action-section { border-top: 2px solid var(--accent); }
#workspace { display: block; overflow-wrap: anywhere; font-size: 11px; margin-top: 5px; }
#shell { display: inline-block; margin: 0 0 8px; padding: 4px 8px; border: 1px solid var(--border); border-radius: 6px; color: var(--muted); font-size: 11px; }
pre {
  margin: 10px 0; white-space: pre-wrap; overflow-wrap: anywhere;
  background: var(--bg); color: var(--text); border: 1px solid var(--border);
  padding: 14px 16px; border-radius: 9px; font: 13px/1.65 var(--vscode-editor-font-family, monospace);
}
#command { border-left: 3px solid var(--accent); background: linear-gradient(90deg, #7B3FE40C, transparent 75%), var(--bg); font-size: 14px; }
code { background: #7B3FE41A; color: var(--text); border: 1px solid #7B3FE433; padding: 2px 5px; border-radius: 5px; font-size: .92em; }
small, #analysis, #paths, #cwd, #result-id { color: var(--muted); }
#cwd { font-size: 12px; overflow-wrap: anywhere; }
#analysis { display: block; line-height: 1.6; }
#risk-summary, #paths { white-space: pre-wrap; overflow-wrap: anywhere; }
#risk-summary { margin: 16px 0 8px; }
#paths { font-size: 12px; }
#explanation { border: 1px solid var(--border); border-radius: 10px; padding: 4px 16px; background: #0E0E1455; }
#explanation p:first-child { margin-top: 12px; }
#explanation p:last-child { margin-bottom: 12px; }
ul { padding-left: 20px; }
li { margin: 9px 0; padding-left: 2px; }
li::marker { color: var(--cyan); }
#buttons { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 22px; padding-top: 18px; border-top: 1px solid var(--border); }
button { min-height: 44px; font: 600 13px/1.4 var(--vscode-font-family, system-ui); padding: 11px 17px; border-radius: 9px; border: 1px solid transparent; cursor: pointer; transition: background .15s, border-color .15s, box-shadow .15s; }
button:focus-visible, summary:focus-visible { outline: 2px solid var(--cyan); outline-offset: 3px; }
button:disabled { opacity: .5; cursor: wait; }
#allow { background: linear-gradient(135deg, var(--accent), #925CEC); color: var(--text); flex: 1 1 200px; box-shadow: 0 4px 18px #7B3FE426; }
#allow:hover:not(:disabled) { background: linear-gradient(135deg, #8A50EF, #A16FF2); box-shadow: 0 4px 24px #7B3FE444; }
#deny { color: var(--danger); background: #FF94A80A; border-color: #FF94A84D; flex: 1 1 120px; }
#deny:hover:not(:disabled) { background: #FF94A819; border-color: var(--danger); }
#cancel { background: transparent; color: var(--muted); border-color: var(--border); margin-top: 12px; }
#cancel:hover { color: var(--text); background: #FFFFFF06; }
#error { color: var(--warning); line-height: 1.6; }
#error:empty { display: none; }
#status[data-tone=running] { color: var(--cyan); border-color: #00ADEE55; background: #00ADEE0D; }
#status[data-tone=waiting] { color: #D8C3FF; border-color: #7B3FE488; background: #7B3FE41A; }
#status[data-tone=warning], #status[data-tone=offline] { color: var(--warning); border-color: #F3C78144; }
#status[data-tone=success] { color: var(--mint); border-color: #42E3B455; background: #42E3B40C; }
#status[data-tone=denied], #status[data-tone=error] { color: var(--danger); border-color: #FF94A855; background: #FF94A80C; }
#status[data-tone=neutral] { color: var(--muted); }
#result-section { border-left: 3px solid var(--border); }
#result-section[data-tone=success] { border-left-color: var(--mint); background: linear-gradient(100deg, #42E3B407, transparent 55%), var(--surface); }
#result-section[data-tone=error], #result-section[data-tone=denied] { border-left-color: var(--danger); }
#result-section[data-tone=warning] { border-left-color: var(--warning); }
#result-summary { font-size: 16px; font-weight: 600; line-height: 1.6; }
#result-section[data-tone=success] #result-summary { color: var(--mint); }
#result-section[data-tone=denied] #result-summary, #result-section[data-tone=error] #result-summary { color: var(--danger); }
#result-id { font: 10px/1.6 var(--vscode-editor-font-family, monospace); overflow-wrap: anywhere; }
details { margin-top: 20px; padding-top: 14px; border-top: 1px solid var(--border); }
summary { cursor: pointer; color: var(--muted); font-size: 12px; }
summary:hover { color: var(--text); }
footer { margin: 22px 2px 0; padding-top: 14px; border-top: 1px solid var(--border); color: var(--muted); font-size: 11px; line-height: 1.7; }
[hidden] { display: none !important; }
@media (max-width: 520px) { main { padding: 20px 14px; } header { gap: 16px; } section { padding: 18px 16px; } h1 { font-size: 23px; } #status { font-size: 11px; } pre { font-size: 12px; padding: 12px; } #command { font-size: 13px; } .eyebrow { font-size: 9px; } }
@media (prefers-reduced-motion: reduce) { button { transition: none; } }
</style></head><body><main><header><div class="brand"><span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 32 36" fill="none"><path d="M16 2 29 7v10c0 8-6 13-13 17C9 30 3 25 3 17V7L16 2Z" stroke="#7B3FE4" stroke-width="2"/><path d="m10 17 4 4 8-9" stroke="#42E3B4" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span><div><small class="eyebrow">КОНТРОЛЬ ДЕЙСТВИЙ АГЕНТА</small><h1>Agent Guard</h1></div></div><span id="status" role="status" aria-live="polite">Подключение…</span></header><p id="error" role="alert"></p><section id="action-section"><p class="section-label">ПРОВЕРКА КОМАНДЫ</p><small id="workspace"></small><h2 id="heading">Ожидание действия</h2><div id="action-content" hidden><p id="shell"></p><pre id="command"></pre><p id="cwd"></p><p id="risk-summary"></p><small id="analysis"></small><p id="paths"></p><h3>Объяснение</h3><div id="explanation"></div></div><div id="buttons" hidden><button id="deny">Отказать</button><button id="allow">Разрешить один раз</button></div><button id="cancel" hidden>Отменить попытку</button></section><section id="result-section"><h2 id="result-title">Последний результат</h2><p id="result-summary">Пока нет результатов</p><div id="result-detail" hidden><small id="result-id"></small><p id="result-message"></p><div id="stdout-wrap" hidden><h3>Вывод команды</h3><pre id="stdout"></pre></div><div id="stderr-wrap" hidden><h3>Сообщения об ошибках</h3><pre id="stderr"></pre></div><p id="truncated"></p><details><summary>Технические данные</summary><pre id="technical"></pre></details></div></section><footer>Каждое разрешение относится только к показанному действию и действует один раз.</footer></main><script nonce="${nonce}">(${panelClient.toString()})(${JSON.stringify(mode)});</script></body></html>`;
}
