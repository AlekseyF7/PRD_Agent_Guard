import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { approvalPage } from '../../../src/approval/page.js';
import { panelRecordDirectory } from '../../../src/mcp/panel-record.js';
import { discoverPanels, panelRequest, parseUiMessage, type PanelRecord } from './connection.js';

export function activate(context: vscode.ExtensionContext) {
  let panel: vscode.WebviewPanel | undefined;
  let selected: PanelRecord | undefined;
  let polling = false; let disposed = false; let lastNotified = '';
  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 30);
  bar.command = 'agentGuard.openPanel'; bar.text = '$(shield) Agent Guard'; bar.tooltip = 'Открыть панель Agent Guard'; bar.show();
  const canonical = (path: string) => { try { const value = realpathSync(path); return process.platform === 'win32' ? value.toLowerCase() : value; } catch { return path; } };
  function findRecord(records: PanelRecord[]): PanelRecord | undefined {
    if (selected) { const current = records.find(record => record.pid === selected!.pid && record.url === selected!.url); if (current) return current; }
    const roots = vscode.workspace.workspaceFolders?.map(folder => canonical(folder.uri.fsPath)) ?? [];
    const matching = records.filter(record => roots.includes(canonical(record.workspaceRoot)));
    return matching.length === 1 ? matching[0] : records.length === 1 ? records[0] : undefined;
  }
  async function choose() {
    const records = discoverPanels(panelRecordDirectory());
    const choice = await vscode.window.showQuickPick(records.map(record => ({ label: `PID ${record.pid}`, description: record.workspaceRoot, record })), { placeHolder: 'Выберите запущенный сервер Agent Guard' });
    if (choice) { selected = choice.record; lastNotified = ''; }
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
      try { const data = await panelRequest(selected, message); await currentPanel?.webview.postMessage({ type: 'guard-response', id: message.id, ok: true, data }); }
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
      selected = findRecord(discoverPanels(panelRecordDirectory()));
      if (!selected) { bar.text = '$(shield) Guard: нет сервера'; return; }
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
    vscode.commands.registerCommand('agentGuard.openPanel', async () => { selected = findRecord(discoverPanels(panelRecordDirectory())) ?? await choose(); if (selected) show(false); }),
    vscode.commands.registerCommand('agentGuard.selectServer', async () => { await choose(); if (selected) show(false); }),
  );
  const timer = setInterval(() => { void poll(); }, 1000);
  context.subscriptions.push({ dispose() { disposed = true; clearInterval(timer); panel?.dispose(); } });
  void poll();
}
