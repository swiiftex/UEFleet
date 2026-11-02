// Produces release/fleet-host.exe (a single file for remote machines) and the full master app,
// which carries a copy of the host so it can be handed to other machines from the Machines window.
import { packager } from '@electron/packager';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const release = path.join(root, 'release');
fs.mkdirSync(release, { recursive: true });

console.log('Building…');
execFileSync(process.execPath, [path.join(root, 'scripts/build.mjs')], { stdio: 'inherit' });

console.log('Packing the remote host…');
const seaConfig = path.join(root, 'dist/host/sea.json');
const blob = path.join(root, 'dist/host/sea.blob');
fs.writeFileSync(seaConfig, JSON.stringify({ main: path.join(root, 'dist/host/fleet-host.cjs'), output: blob, disableExperimentalSEAWarning: true, useCodeCache: false, useSnapshot: false }));
execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });
const exe = path.join(release, 'fleet-host.exe');
fs.rmSync(exe, { force: true });
fs.copyFileSync(process.execPath, exe);
execFileSync(process.execPath, [
  path.join(root, 'node_modules/postject/dist/cli.js'), exe, 'NODE_SEA_BLOB', blob,
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
], { stdio: 'inherit' });
console.log(`  ${exe}: ${(fs.statSync(exe).size / 2 ** 20).toFixed(0)} MB`);

console.log('Packing the master app…');
const keep = new Set(['dist', 'package.json']);
const [appPath] = await packager({
  dir: root,
  out: release,
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
