// Turns the bundled host into a single exe, by stamping it onto a copy of this Node.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function packHost(root, exe) {
  const seaConfig = path.join(root, 'dist/host/sea.json');
  const blob = path.join(root, 'dist/host/sea.blob');
  fs.writeFileSync(seaConfig, JSON.stringify({ main: path.join(root, 'dist/host/fleet-host.cjs'), output: blob, disableExperimentalSEAWarning: true, useCodeCache: false, useSnapshot: false }));
  execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });
  fs.rmSync(exe, { force: true });
  fs.copyFileSync(process.execPath, exe);
  execFileSync(process.execPath, [
    path.join(root, 'node_modules/postject/dist/cli.js'), exe, 'NODE_SEA_BLOB', blob,
    '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ], { stdio: 'inherit' });
}
