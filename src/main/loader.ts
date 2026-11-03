// What the packaged app actually starts. It loads the newest deployed version from the data folder,
// so a new version doesn't have to replace files inside the running app, and falls back to the one
// that shipped with it if that won't load.
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

function deployedMain(): string | null {
  if (!app.isPackaged) return null;
  const dataDir = process.env.FLEET_DATA ?? path.join(process.env.LOCALAPPDATA ?? '', 'uefleet');
  try {
    const { id } = JSON.parse(fs.readFileSync(path.join(dataDir, 'app', 'current.json'), 'utf8'));
    const file = path.join(dataDir, 'app', id, 'main.cjs');
    return fs.existsSync(file) ? file : null;
  } catch {
    return null;
  }
}

function load() {
  const file = deployedMain();
  if (file) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require(file);
      return;
    } catch (e) {
      console.error(`Couldn't load ${file}, so using the built-in version:`, e);
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('./main.cjs');
}

load();
