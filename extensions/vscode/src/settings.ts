import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { hostRequest, type PanelRecord } from './connection.js';
import type { UserSettings } from '../../../src/mcp/settings.js';

interface Metadata { settings: UserSettings; hasKey: boolean; configured: boolean }
const keyName = (reference: string) => `agent-guard:${reference}`;
const labels: Record<keyof UserSettings['policies'], string> = {
  file_delete: 'Удаление файлов', git_destructive: 'Разрушительные Git-операции',
  git_force_push: 'Принудительный push', outside_workspace: 'Известные цели вне проекта',
};
export async function hydrateCredential(context: vscode.ExtensionContext, record: PanelRecord, reference: string) {
  if (!/^vscode:[0-9a-f-]{36}$/.test(reference)) return;
  let key: string | undefined;
  try { key = await context.secrets.get(keyName(reference)); }
  catch { void vscode.window.showErrorMessage('Agent Guard: хранилище ключей недоступно. Ключ не загружен.'); }
  await hostRequest(record, '/api/key', { credentialRef: reference, ...(key ? { key } : {}) });
}
export async function openSettings(context: vscode.ExtensionContext, record: PanelRecord) {
  try {
    while (true) {
      const meta = await hostRequest(record, '/api/settings') as Metadata;
      const choice = await vscode.window.showQuickPick([
        { label: '$(shield) Политики автоблокировки', value: 'policies', description: 'Paranoid: блокировать или спрашивать' },
        { label: '$(cloud) Подключение LLM', value: 'llm', description: `${meta.settings.llm.model} · ${meta.settings.llm.authMode}` },
        { label: '$(plug) Проверить подключение', value: 'check', description: 'Без выполнения команды' },
        { label: '$(trash) Удалить сохранённый ключ', value: 'delete', description: meta.hasKey ? 'Ключ загружен' : 'Наличие ключа проверяется в хранилище' },
        { label: '$(lock) Проверить хранилище', value: 'storage', description: 'Записать, прочитать и удалить случайное тестовое значение' },
      ], { title: 'Agent Guard — настройки', placeHolder: record.workspaceRoot });
      if (!choice) return;
      if (choice.value === 'policies') {
        const policies = { ...meta.settings.policies };
        while (true) {
          const items = Object.entries(labels).map(([key, label]) => ({ label: `${policies[key as keyof typeof policies] === 'block' ? '$(lock)' : '$(question)'} ${label}`, description: policies[key as keyof typeof policies] === 'block' ? 'Блокировать автоматически' : 'Запрашивать решение', value: key }));
          const item = await vscode.window.showQuickPick([...items, { label: '$(check) Сохранить', description: 'Ожидающие подтверждения будут отменены', value: 'save' }], { title: 'Политики: выберите пункт для переключения' });
          if (!item) break;
          if (item.value === 'save') {
            await hostRequest(record, '/api/settings', { settings: { ...meta.settings, policies } });
            void vscode.window.showInformationMessage('Agent Guard: политики сохранены. Ожидающие попытки отменены.'); break;
          }
          const category = item.value as keyof typeof policies;
          policies[category] = policies[category] === 'block' ? 'ask' : 'block';
        }
      } else if (choice.value === 'llm') {
        await editLlm(context, record, meta);
      } else if (choice.value === 'check') {
        const ref = meta.settings.llm.credentialRef;
        if (ref?.startsWith('vscode:')) await hydrateCredential(context, record, ref);
        const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Agent Guard: проверяем модель', cancellable: false }, async () =>
          await hostRequest(record, '/api/connection-check', {}, Math.min(meta.settings.llm.timeoutMs + 12000, 312000)) as { ok: boolean; message: string });
        if (result.ok) void vscode.window.showInformationMessage(result.message);
        else void vscode.window.showErrorMessage('Agent Guard: ' + result.message);
      } else if (choice.value === 'delete') {
        const ref = meta.settings.llm.credentialRef;
        if (!ref?.startsWith('vscode:')) { void vscode.window.showInformationMessage('Сейчас используется окружение либо подключение без ключа. Сохранённый ключ не выбран.'); continue; }
        const confirm = await vscode.window.showQuickPick(['Удалить выбранный ключ', 'Отмена'], { title: 'Следующие объяснения потребуют нового ключа' });
        if (confirm !== 'Удалить выбранный ключ') continue;
        await hostRequest(record, '/api/key', { credentialRef: ref });
        await context.secrets.delete(keyName(ref));
        // Cancel pending attempts on a credential change as on a settings change.
        await hostRequest(record, '/api/settings', { settings: meta.settings });
        void vscode.window.showInformationMessage('Agent Guard: выбранный ключ удалён.');
      } else if (choice.value === 'storage') {
        const name = `agent-guard:storage-check:${randomUUID()}`; const value = randomUUID();
        try {
          await context.secrets.store(name, value);
          if (await context.secrets.get(name) !== value) throw Error('Storage read failed');
        } finally { await context.secrets.delete(name); }
        void vscode.window.showInformationMessage('Agent Guard: запись, чтение и удаление тестового секрета прошли.');
      }
    }
  } catch { void vscode.window.showErrorMessage('Agent Guard: настройки не применены либо операция не завершена. Проверьте сервер и хранилище; дождитесь завершения исполняющейся команды. Секреты открытым текстом не сохраняются.'); }
}
async function editLlm(context: vscode.ExtensionContext, record: PanelRecord, meta: Metadata) {
  const old = meta.settings.llm;
  const baseURL = await vscode.window.showInputBox({ title: 'LLM: адрес API', value: old.baseURL, prompt: 'Облачный API либо локальный OpenAI-совместимый сервер, например http://localhost:1234/v1' });
  if (baseURL === undefined) return;
  const model = await vscode.window.showInputBox({ title: 'LLM: идентификатор модели', value: old.model, validateInput: value => value.trim() ? undefined : 'Укажите модель' });
  if (model === undefined) return;
  const timeout = await vscode.window.showInputBox({ title: 'LLM: время ожидания в миллисекундах', value: String(old.timeoutMs), validateInput: value => /^\d+$/.test(value) && Number(value) >= 1000 && Number(value) <= 300000 ? undefined : 'От 1000 до 300000 мс' });
  if (timeout === undefined) return;
  const keep = baseURL === old.baseURL && old.authMode === 'apiKey' && old.credentialRef;
  const choices = [
    ...(keep ? [{ label: 'Сохранить текущий источник ключа', value: 'keep' }] : []),
    { label: 'Ввести новый API-ключ', value: 'new' },
    { label: 'Без ключа (локальная модель)', value: 'none' },
    { label: 'Переменная окружения (для разработки)', value: 'env' },
  ];
  const auth = await vscode.window.showQuickPick(choices, { title: 'Источник ключа для выбранного адреса', placeHolder: baseURL !== old.baseURL ? 'Адрес изменён: прежний ключ автоматически не переносится' : 'Сохранённый ключ никогда не показывается в форме' });
  if (!auth) return;
  let newRef: string | undefined;
  let credentialRef: string | undefined;
  let confirmKeyReuse = false;
  if (auth.value === 'keep') credentialRef = old.credentialRef;
  else if (auth.value === 'new') {
    const key = await vscode.window.showInputBox({ title: 'Новый API-ключ', prompt: 'Сохранится через SecretStorage VS Code. Отмена не меняет настройки.', password: true, ignoreFocusOut: true, validateInput: value => value.trim() && value === value.trim() && value.length <= 4096 && !/[\r\n\0]/.test(value) ? undefined : 'Укажите ключ без пробелов по краям и перевода строки' });
    if (key === undefined) return;
    if (baseURL.includes(key) || model.includes(key)) { void vscode.window.showErrorMessage('Ключ не должен содержаться в адресе или названии модели. Настройки не сохранены.'); return; }
    newRef = credentialRef = `vscode:${randomUUID()}`;
    await context.secrets.store(keyName(newRef), key);
  } else if (auth.value === 'env') {
    credentialRef = await vscode.window.showInputBox({ title: 'Имя переменной окружения', value: 'AGENT_GUARD_LLM_API_KEY', validateInput: value => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) ? undefined : 'Нужно имя переменной, не значение ключа' });
    if (credentialRef === undefined) return;
    if (baseURL !== old.baseURL && credentialRef === old.credentialRef) {
      if (await vscode.window.showQuickPick(['Передавать ключ из этой переменной новому адресу', 'Отмена'], { title: baseURL }) !== 'Передавать ключ из этой переменной новому адресу') return;
      confirmKeyReuse = true;
    }
  }
  const llm = { baseURL, model, timeoutMs: Number(timeout), authMode: auth.value === 'none' ? 'none' as const : 'apiKey' as const, ...(credentialRef ? { credentialRef } : {}) };
  try { await hostRequest(record, '/api/settings', { settings: { ...meta.settings, llm }, confirmKeyReuse }); }
  catch (error) { if (newRef) await context.secrets.delete(keyName(newRef)); throw error; }
  if (credentialRef?.startsWith('vscode:')) await hydrateCredential(context, record, credentialRef);
  if (old.credentialRef?.startsWith('vscode:') && old.credentialRef !== credentialRef) {
    try { await context.secrets.delete(keyName(old.credentialRef)); }
    catch { void vscode.window.showWarningMessage('Новые настройки сохранены; прежний неиспользуемый ключ не удалось удалить из хранилища.'); }
  }
  void vscode.window.showInformationMessage('Agent Guard: подключение сохранено. Ожидающие попытки отменены. Теперь проверьте подключение.');
}
