import { app, BrowserWindow, clipboard, dialog, ipcMain, Notification, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { Hub } from '../hub/hub';
import { dataRoot } from '../node/machine';
import type { AgentCard, HubEvent } from '../shared/protocol';

const VERSION = '1.0.0';
const demo = process.env.FLEET_DEMO === '1';
const dataDir = process.env.FLEET_DATA ?? dataRoot('uefleet');
const CALLABLE = new Set([
  'snapshot', 'createAgent', 'send', 'broadcast', 'decide', 'answer', 'interrupt', 'stopAgent', 'archive',
  'dismissAttention', 'transcript', 'setTestDone', 'addProject', 'setMaxInstances', 'rotatePairing',
  'forgetMachine', 'changes', 'apply', 'applyFinished', 'log', 'stopInstance',
]);

let win: BrowserWindow | null = null;
let hub: Hub;

function hostAppPath(): string | null {
  const candidates = [
    path.join(process.resourcesPath ?? '', 'fleet-host.exe'),
    path.join(app.getAppPath(), 'release', 'fleet-host.exe'),
    path.join(app.getAppPath(), '..', 'release', 'fleet-host.exe'),
  ];
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1800,
    height: 1000,
    minWidth: 1100,
    minHeight: 640,
    backgroundColor: '#090c11',
    title: 'UE Fleet',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#090c11', symbolColor: '#8693a3', height: 34 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('focus', () => win?.flashFrame(false));
  win.on('closed', () => { win = null; });
}

app.whenReady().then(async () => {
  hub = new Hub({ dataDir, version: VERSION, demo, hostAppPath: hostAppPath() });
  hub.on('hub', (e: HubEvent) => win?.webContents.send('hub:event', e));
  hub.on('attention', (card: AgentCard) => {
    if (!win || win.isFocused() || !card.attention) return;
    win.flashFrame(true);
    if (!Notification.isSupported()) return;
    const n = new Notification({ title: `${String(card.index).padStart(2, '0')} ${card.title}`, body: card.attention.text });
    n.on('click', () => {
      win?.show();
      win?.focus();
      win?.webContents.send('hub:select', card.id);
    });
    n.show();
  });

  ipcMain.handle('hub:call', async (_e, method: string, args: unknown[]) => {
    if (!CALLABLE.has(method)) throw new Error(`Not callable: ${method}`);
    return (hub as any)[method](...args);
  });
  ipcMain.handle('app:pickProject', async () => {
    const r = await dialog.showOpenDialog(win!, { title: 'Choose an Unreal project', filters: [{ name: 'Unreal project', extensions: ['uproject'] }], properties: ['openFile'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('app:copy', (_e, text: string) => clipboard.writeText(text));
  ipcMain.handle('app:reveal', (_e, p: string) => shell.showItemInFolder(p));

  await hub.start();
  createWindow();
});

let quitting = false;
app.on('before-quit', (e) => {
  if (quitting) return;
  quitting = true;
  e.preventDefault();
  void hub.shutdown().finally(() => app.exit(0));
});
app.on('window-all-closed', () => app.quit());
