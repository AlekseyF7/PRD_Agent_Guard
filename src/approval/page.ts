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
:root{color-scheme:dark}*{box-sizing:border-box}body{font:14px var(--vscode-font-family,system-ui);background:var(--vscode-editor-background,#10151d);color:var(--vscode-editor-foreground,#e5eaf1);margin:0}main{max-width:900px;margin:auto;padding:24px}header{display:flex;gap:16px;flex-wrap:wrap;justify-content:space-between;align-items:center}h1{font-size:24px;margin:0}h2{font-size:18px;margin:0 0 16px}h3{font-size:14px}#status{display:inline-block;border:1px solid currentColor;border-radius:20px;padding:7px 12px;font-weight:600}section{background:var(--vscode-sideBar-background,#1b2431);border:1px solid #36445a;border-radius:12px;padding:20px;margin:20px 0;border-left:4px solid #52657e}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--vscode-textCodeBlock-background,#10151d);padding:12px;border-radius:8px;font:13px var(--vscode-editor-font-family,monospace)}code{background:var(--vscode-textCodeBlock-background,#10151d);padding:1px 4px;border-radius:4px}p,li{line-height:1.55}li{margin:6px 0}ul{padding-left:22px}button{font:inherit;padding:10px 14px;border-radius:7px;border:0;margin:8px 8px 0 0;cursor:pointer}button:disabled{opacity:.55;cursor:wait}#allow{background:#91e4b1;color:#10251b}#deny{background:#ffb5ad;color:#301312}#cancel{background:#dce5f2;color:#182332}small,#analysis,#paths,#result-id{color:var(--vscode-descriptionForeground,#b3bfd1)}#error{color:#f3c781}#risk-summary,#paths{white-space:pre-wrap}#status[data-tone=running]{color:#81bbff}#status[data-tone=waiting],#status[data-tone=warning],#status[data-tone=offline]{color:#f3c781}#status[data-tone=success]{color:#91e4b1}#status[data-tone=denied],#status[data-tone=error]{color:#ffb5ad}#result-section[data-tone=success]{border-left-color:#91e4b1}#result-section[data-tone=error],#result-section[data-tone=denied]{border-left-color:#ffb5ad}#result-summary{font-weight:600}details{margin-top:16px}summary{cursor:pointer;color:var(--vscode-descriptionForeground,#b3bfd1)}[hidden]{display:none!important}
</style></head><body><main><header><h1>Agent Guard</h1><span id="status" role="status" aria-live="polite">Подключение…</span></header><p id="error" role="alert"></p><section><small id="workspace"></small><h2 id="heading">Ожидание действия</h2><div id="action-content" hidden><p id="shell"></p><pre id="command"></pre><p id="cwd"></p><p id="risk-summary"></p><small id="analysis"></small><p id="paths"></p><h3>Объяснение</h3><div id="explanation"></div></div><div id="buttons" hidden><button id="deny">Отказать</button><button id="allow">Разрешить один раз</button></div><button id="cancel" hidden>Отменить попытку</button></section><section id="result-section"><h2 id="result-title">Последний результат</h2><p id="result-summary">Пока нет результатов</p><div id="result-detail" hidden><small id="result-id"></small><p id="result-message"></p><div id="stdout-wrap" hidden><h3>Вывод команды</h3><pre id="stdout"></pre></div><div id="stderr-wrap" hidden><h3>Сообщения об ошибках</h3><pre id="stderr"></pre></div><p id="truncated"></p><details><summary>Технические данные</summary><pre id="technical"></pre></details></div></section><small>Одна активная попытка. Каждое разрешение действует один раз.</small></main><script nonce="${nonce}">(${panelClient.toString()})(${JSON.stringify(mode)});</script></body></html>`;
}
