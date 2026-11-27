import type { Explanation } from '../core/types.js';
import { environmentKeySource } from './credentials.js';
import { buildMessages } from './prompt.js';
import { copyAction, correlationId, parseSettings } from './validation.js';
import type { LlmDependencies, LlmErrorCode } from './types.js';

export const MAX_BODY_BYTES = 64 * 1024;
const messages: Record<LlmErrorCode, string> = {
  INVALID_ACTION: 'Некорректное действие для объяснения.',
  MISSING_API_KEY: 'Ключ для выбранного подключения не задан.',
  INVALID_API_KEY: 'Ключ имеет недопустимый формат.',
  CREDENTIAL_ERROR: 'Не удалось получить ключ из выбранного источника.',
  TIMEOUT: 'Превышено время ожидания объяснения.',
  NETWORK_ERROR: 'Не удалось связаться с сервисом объяснения.',
  AUTH_ERROR: 'Сервис отклонил авторизацию.',
  RATE_LIMIT: 'Достигнут лимит запросов или доступной квоты сервиса.',
  SERVER_ERROR: 'Ошибка сервиса объяснения.',
  HTTP_ERROR: 'Сервис вернул неуспешный HTTP-ответ.',
  INVALID_RESPONSE: 'Нет завершённого текстового объяснения в поддерживаемом формате.',
  REQUEST_TOO_LARGE: 'Данные действия превышают предел запроса.',
  RESPONSE_TOO_LARGE: 'Ответ сервиса превышает допустимый размер.',
  SENSITIVE_DATA: 'Обнаружен текущий ключ в данных; объяснение не передаётся.',
};
function unavailable(actionId: string, code: LlmErrorCode): Explanation {
  return Object.freeze({ actionId, status: 'unavailable', error: Object.freeze({ code, message: messages[code] }) });
}
class BodyTooLarge extends Error {}
class InvalidBody extends Error {}

async function readBody(response: Response, signal: AbortSignal): Promise<string> {
  if (Number(response.headers.get('content-length')) > MAX_BODY_BYTES) {
    void response.body?.cancel().catch(() => {});
    throw new BodyTooLarge();
  }
  if (!response.body) throw new InvalidBody();
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_BODY_BYTES) throw new BodyTooLarge();
      chunks.push(next.value);
    }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
    catch { throw new InvalidBody(); }
  } finally {
    signal.removeEventListener('abort', cancel);
    if (signal.aborted || size > MAX_BODY_BYTES) cancel();
    reader.releaseLock();
  }
}

function explanationText(raw: string): string | undefined {
  try {
    const body = JSON.parse(raw);
    const choice = body?.choices?.[0];
    const message = choice?.message;
    if (choice?.finish_reason !== 'stop' || message?.role !== 'assistant' || message?.refusal || message?.function_call || message?.tool_calls?.length) return;
    if (typeof message.content !== 'string' || !message.content.trim()) return;
    return message.content.trim();
  } catch { return; }
}

export function createLlmClient(input: unknown, dependencies: LlmDependencies = {}) {
  const settings = parseSettings(input);
  const resolveApiKey = dependencies.resolveApiKey ?? environmentKeySource();
  const fetchApi = dependencies.fetch ?? globalThis.fetch;
  const endpoint = `${settings.baseURL}/chat/completions`;

  async function explain(inputAction: unknown): Promise<Explanation> {
    const action = copyAction(inputAction);
    if (!action) return unavailable(correlationId(inputAction), 'INVALID_ACTION');
    const actionId = action.actionId;
    // All action values and settings are copied before asynchronous dependencies run.
    const body = JSON.stringify({ model: settings.model, messages: buildMessages(action), stream: false });
    const actionText = [action.command, action.cwd, ...action.affectedPaths,
      ...action.risks.flatMap(risk => [risk.ruleId, risk.category, risk.reason])].join('\n');
    if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) return unavailable(actionId, 'REQUEST_TOO_LARGE');
    const controller = new AbortController();
    const { signal } = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<Explanation>(resolve => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(unavailable(actionId, 'TIMEOUT'));
      }, settings.timeoutMs);
    });

    async function perform(): Promise<Explanation> {
      let key: string | undefined;
      if (settings.authMode === 'apiKey') {
        try { key = await resolveApiKey(settings.credentialRef!); }
        catch { return unavailable(actionId, signal.aborted ? 'TIMEOUT' : 'CREDENTIAL_ERROR'); }
        if (signal.aborted) return unavailable(actionId, 'TIMEOUT');
        if (key === undefined || key === '') return unavailable(actionId, 'MISSING_API_KEY');
        if (typeof key !== 'string' || !key.trim() || key !== key.trim() || /[\r\n\0]/.test(key)) return unavailable(actionId, 'INVALID_API_KEY');
        if (body.includes(key) || actionText.includes(key)) return unavailable(actionId, 'SENSITIVE_DATA');
      }
      try {
        signal.throwIfAborted();
        const response = await fetchApi(endpoint, {
          method: 'POST', redirect: 'manual', credentials: 'omit', signal,
          headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
          body,
        });
        signal.throwIfAborted();
        if (!response.ok) {
          // Error bodies can echo credentials. Never read or return them.
          void response.body?.cancel().catch(() => {});
          const status = response.status;
          const code = status === 401 || status === 403 ? 'AUTH_ERROR' : status === 429 ? 'RATE_LIMIT'
            : status >= 500 ? 'SERVER_ERROR' : 'HTTP_ERROR';
          return unavailable(actionId, code);
        }
        const raw = await readBody(response, signal);
        signal.throwIfAborted();
        // A provider must not be able to echo the known credential into logs/results.
        if (key && raw.includes(key)) return unavailable(actionId, 'SENSITIVE_DATA');
        const text = explanationText(raw);
        if (!text) return unavailable(actionId, 'INVALID_RESPONSE');
        if (key && text.includes(key)) return unavailable(actionId, 'SENSITIVE_DATA');
        return Object.freeze({ actionId, status: 'available', text });
      } catch (error) {
        return unavailable(actionId, signal.aborted ? 'TIMEOUT' : error instanceof BodyTooLarge ? 'RESPONSE_TOO_LARGE'
          : error instanceof InvalidBody ? 'INVALID_RESPONSE' : 'NETWORK_ERROR');
      }
    }
    try { return await Promise.race([perform(), deadline]); }
    finally { if (timer !== undefined) clearTimeout(timer); }
  }
  return Object.freeze({ settings, explain });
}
