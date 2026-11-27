import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { approvalPage } from '../../../src/approval/page.js';
import { panelRecordDirectory } from '../../../src/mcp/panel-record.js';
import { discoverPanels, panelRequest, parseUiMessage, selectPanelRecord, type PanelRecord } from './connection.js';

export function activate(context: vscode.ExtensionContext) {
  let panel: vscode.WebviewPanel | undefined;
  let selected: PanelRecord | undefined;
  let explicitSelection = false;
  let polling = false; let disposed = false; let lastNotified = '';
  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 30);
  bar.command = 'agentGuard.openPanel'; bar.text = '$(shield) Agent Guard'; bar.tooltip = 'Открыть панель Agent Guard'; bar.show();
  const canonical = (path: string) => { try { const value = realpathSync(path); return process.platform === 'win32' ? value.toLowerCase() : value; } catch { return path; } };
  async function findRecord(records: PanelRecord[]): Promise<PanelRecord | undefined> {
    if (explicitSelection && !records.some(record => record.pid === selected?.pid && record.url === selected.url)) explicitSelection = false;
    const roots = vscode.workspace.workspaceFolders?.map(folder => canonical(folder.uri.fsPath)) ?? [];
    return selectPanelRecord(records, roots, canonical, selected, explicitSelection,
      async record => await panelRequest(record, { type: 'guard-request', id: 1, path: '/api/state' }) as { active?: unknown; pending?: unknown });
  }
  async function choose() {
    const records = discoverPanels(panelRecordDirectory());
    const choice = await vscode.window.showQuickPick(records.map(record => ({ label: `PID ${record.pid}`, description: record.workspaceRoot, record })), { placeHolder: 'Выберите запущенный сервер Agent Guard' });
    if (choice) { selected = choice.record; explicitSelection = true; lastNotified = ''; }
    else if (!records.length) void vscode.window.showInformationMessage('Сначала запустите MCP-сервер Agent Guard или npm run guard:check.');
    return selected;
  }
  function show(preserveFocus: boolean) {
    if (panel) { panel.reveal(vscode.ViewColumn.Beside, preserveFocus); return; }
    panel = vscode.window.createWebviewPanel('agentGuard', 'Agent Guard', { viewColumn: vscode.ViewColumn.Beside, preserveFocus }, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
    panel.webview.html = approvalPage(randomBytes(18).toString('base64'), 'vscode');
    panel.webview.onDidReceiveMessage(async input => {
      const message = parseUiMessage(input);
      if (!message || !selected) return;
      const currentPanel = panel;
      const target = selected;
      try { const data = await panelRequest(target, message); if (selected?.url === target.url) await currentPanel?.webview.postMessage({ type: 'guard-response', id: message.id, ok: true, data }); }
      catch { await currentPanel?.webview.postMessage({ type: 'guard-response', id: message.id, ok: false }); }
    }, undefined, context.subscriptions);
    panel.onDidDispose(() => {
      panel = undefined;
      if (selected) void panelRequest(selected, { type: 'guard-request', id: 1, path: '/api/cancel', body: {} }).catch(() => {});
    }, undefined, context.subscriptions);
  }
  async function poll() {
    if (polling || disposed) return; polling = true;
    try {
      const records = discoverPanels(panelRecordDirectory());
      selected = await findRecord(records);
      if (!selected) { bar.text = records.length ? '$(bell) Guard: выберите сервер' : '$(shield) Guard: нет сервера'; return; }
      const state = await panelRequest(selected, { type: 'guard-request', id: 1, path: '/api/state' }) as { active?: { phase: string; action: { actionId: string } }; pending?: { action: { actionId: string } }; last?: { status: string; exitCode?: number; code?: string } };
      bar.text = state.pending ? '$(bell) Guard: нужно решение' : state.active ? '$(sync~spin) Guard: обработка' : state.last?.status === 'completed' && state.last.exitCode === 0 ? '$(check) Guard: выполнено' : '$(shield) Agent Guard';
      const id = state.pending?.action.actionId;
      if (id && id !== lastNotified) {
        lastNotified = id;
        if (vscode.workspace.getConfiguration('agentGuard').get<boolean>('autoOpen', true)) show(true);
      }
    } catch { bar.text = '$(warning) Guard: нет соединения'; }
    finally { polling = false; }
  }
  context.subscriptions.push(bar,
    vscode.commands.registerCommand('agentGuard.openPanel', async () => { selected = await findRecord(discoverPanels(panelRecordDirectory())) ?? await choose(); if (selected) show(false); }),
    vscode.commands.registerCommand('agentGuard.selectServer', async () => { await choose(); if (selected) show(false); }),
  );
  const timer = setInterval(() => { void poll(); }, 1000);
  context.subscriptions.push({ dispose() { disposed = true; clearInterval(timer); panel?.dispose(); } });
  void poll();
}
