import { app, BrowserWindow, clipboard, dialog, ipcMain, Notification, safeStorage, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { Hub, type LocalHostCommand } from '../hub/hub';
import { dataRoot } from '../node/machine';
import type { AgentCard, HubEvent } from '../shared/protocol';

const VERSION = '1.0.0';
const VERSION_POLL_MS = 1500;
const demo = process.env.FLEET_DEMO === '1';
const dataDir = process.env.FLEET_DATA ?? dataRoot('uefleet');
// A second copy with its own data shouldn't share a window's saved settings with the real one either.
if (process.env.FLEET_DATA) app.setPath('userData', path.join(dataDir, 'window'));
const CALLABLE = new Set([
  'snapshot', 'createAgent', 'request', 'send', 'broadcast', 'decide', 'answer', 'interrupt', 'stopAgent', 'archive',
  'dismissAttention', 'transcript', 'setTestDone', 'addProject', 'setMaxInstances', 'rotatePairing',
  'forgetMachine', 'changes', 'log', 'stopInstance', 'testChanges', 'approve', 'reportIssue', 'resolveConflicts', 'restartHost', 'setApiCreditsEnabled', 'releaseWorkspace', 'setMasterPermissions',
]);

let win: BrowserWindow | null = null;
let hub: Hub;

function hostAppPath(): string | null {
  const candidates = [
    // A deployed version carries its own, next to this file.
    path.join(__dirname, 'fleet-host.exe'),
    path.join(process.resourcesPath ?? '', 'fleet-host.exe'),
    path.join(app.getAppPath(), 'release', 'fleet-host.exe'),
    path.join(app.getAppPath(), '..', 'release', 'fleet-host.exe'),
  ];
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

// This PC's agents and editors run in a host of their own, so restarting the app leaves them running.
function localHost(): LocalHostCommand | undefined {
  if (process.env.FLEET_INLINE_LOCAL === '1') return undefined;
  if (!app.isPackaged) return { command: process.execPath, args: [path.join(__dirname, 'host', 'fleet-host.cjs')], env: { ELECTRON_RUN_AS_NODE: '1' } };
  const from = hostAppPath();
  return from ? { command: path.join(dataDir, 'host', 'fleet-host.exe'), args: [], installFrom: from } : undefined;
}

// ---- New versions ----
// `npm run deploy` puts a version under app/<id> in the data folder and points current.json at it.

interface VersionFile { id: string; main: string; preload: string; renderer: string; host?: string }

const readJson = <T,>(file: string): T | null => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};
const versionsDir = path.join(dataDir, 'app');
const running = readJson<VersionFile>(path.join(__dirname, 'version.json'));
let pending: VersionFile | null = null;
let shownRenderer = running?.renderer;
let shownHost = running?.host;

function checkForNewVersion() {
  const current = readJson<VersionFile>(path.join(versionsDir, 'current.json'));
  if (!current || current.id === (pending?.id ?? running?.id)) return;
  const version = readJson<VersionFile>(path.join(versionsDir, current.id, 'version.json'));
  if (!version) return;
  pending = version;
  if (version.host && version.host !== shownHost) {
    shownHost = version.host;
    void hub.setHostExe(path.join(versionsDir, version.id, 'fleet-host.exe'));
  }
  const needsRestart = version.main !== running?.main || version.preload !== running?.preload;
  if (needsRestart || version.renderer !== shownRenderer) hub.setAppUpdate({ id: version.id, needsRestart });
}

async function applyUpdate() {
  if (!pending) return;
  const version = pending;
  if (version.main !== running?.main || version.preload !== running?.preload) {
    quitting = true;
    await hub.detach();
    if (process.env.FLEET_TEST_NO_RELAUNCH !== '1') app.relaunch();
    app.exit(0);
    return;
  }
  // Only the screens changed, and everything they show lives in the hub, so nothing is lost.
  shownRenderer = version.renderer;
  hub.setAppUpdate(null);
  await win?.loadFile(path.join(versionsDir, version.id, 'renderer', 'index.html'));
}

// ---- The API key ----
// Encrypted for this Windows account, and never passed back to the screens.

const apiKeyFile = path.join(dataDir, 'api-key.bin');

function savedApiKey() {
  try { return safeStorage.decryptString(fs.readFileSync(apiKeyFile)); } catch { return null; }
}

// It says whether the key works, without spending anything. Only the Console shows the balance.
async function setApiKey(key: string | null): Promise<string | null> {
  if (key) {
    const base = process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com';
    const res = await fetch(`${base}/v1/models?limit=1`, { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } }).catch(() => null);
    if (res?.status === 401 || res?.status === 403) return 'Anthropic refused that key.';
    if (!safeStorage.isEncryptionAvailable()) return "Windows can't encrypt the key on this PC, so it wasn't saved.";
    fs.writeFileSync(apiKeyFile, safeStorage.encryptString(key));
  } else {
    fs.rmSync(apiKeyFile, { force: true });
  }
  hub.setApiKey(key);
  return null;
}

function createWindow() {
  // For tests on a PC someone is using: it still renders, but stays off screen and never takes focus.
  const unseen = process.env.FLEET_TEST_UNSEEN === '1';
  win = new BrowserWindow({
    width: 1800,
    height: 1000,
    show: !unseen,
    ...(unseen ? { x: -6000, y: 0 } : {}),
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
  if (unseen) win.showInactive();
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
  hub = new Hub({ dataDir, version: VERSION, demo, hostAppPath: hostAppPath(), localHost: localHost() });
  hub.setApiKey(savedApiKey());
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
  ipcMain.handle('app:applyUpdate', () => applyUpdate());
  ipcMain.handle('app:setApiKey', (_e, key: string | null) => setApiKey(key));

  await hub.start();
  createWindow();
  setInterval(checkForNewVersion, VERSION_POLL_MS);
});

let quitting = false;
app.on('before-quit', (e) => {
  if (quitting) return;
  quitting = true;
  e.preventDefault();
  void hub.shutdown().finally(() => app.exit(0));
});
app.on('window-all-closed', () => app.quit());
