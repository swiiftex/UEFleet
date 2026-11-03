// Produces release/fleet-host.exe (a single file for remote machines) and the full master app,
// which carries a copy of the host so it can be handed to other machines from the Machines window.
import { packager } from '@electron/packager';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { packHost } from './pack-host.mjs';

const root = path.resolve(import.meta.dirname, '..');
const release = path.join(root, 'release');
fs.mkdirSync(release, { recursive: true });

console.log('Building…');
execFileSync(process.execPath, [path.join(root, 'scripts/build.mjs')], { stdio: 'inherit' });

console.log('Packing the remote host…');
const exe = path.join(release, 'fleet-host.exe');
packHost(root, exe);
console.log(`  ${exe}: ${(fs.statSync(exe).size / 2 ** 20).toFixed(0)} MB`);

// So the app knows what it shipped with, and can tell what a later deploy changed.
const versionFile = path.join(root, 'dist', 'version.json');
const version = JSON.parse(fs.readFileSync(versionFile, 'utf8'));
version.host = crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex');
fs.writeFileSync(versionFile, JSON.stringify(version, null, 2));

// A running copy of the app locks its own folder, so that one can't be replaced until it's closed.
const appFolder = path.join(release, 'UE Fleet-win32-x64');
const locked = () => {
  try {
    if (fs.existsSync(appFolder)) fs.renameSync(appFolder, `${appFolder}.check`);
    if (fs.existsSync(`${appFolder}.check`)) fs.renameSync(`${appFolder}.check`, appFolder);
    return false;
  } catch { return true; }
};
const out = locked() ? path.join(release, 'next') : release;
if (out !== release) console.log('UE Fleet is open, so this goes in release/next instead.');
else fs.rmSync(path.join(release, 'next'), { recursive: true, force: true });

console.log('Packing the master app…');
const keep = new Set(['dist', 'package.json']);
const [appPath] = await packager({
  dir: root,
  out,
  overwrite: true,
  name: 'UE Fleet',
  executableName: 'UE Fleet',
  platform: 'win32',
  arch: 'x64',
  asar: true,
  prune: false,
  extraResource: [exe],
  ignore: (p) => {
    if (!p) return false;
    const top = p.split('/').filter(Boolean)[0];
    if (!keep.has(top)) return true;
    // Any .mjs at the top of dist is a bundled real-editor test, not part of the app.
    return p.startsWith('/dist/test') || p.startsWith('/dist/host') || /^\/dist\/[^/]+\.mjs$/.test(p);
  },
});
console.log(`  ${appPath}`);
