// Publishes the current code to a running UE Fleet, with nothing to close first. It builds a version
// under app/<id> in the data folder and points current.json at it. The app notices within a couple of
// seconds, and hosts on other machines follow by themselves. `--watch` keeps doing it as code changes.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { packHost } from './pack-host.mjs';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
const dataDir = process.env.FLEET_DATA ?? path.join(process.env.LOCALAPPDATA ?? '', 'uefleet');
const versions = path.join(dataDir, 'app');
const pointer = path.join(versions, 'current.json');
const KEEP_VERSIONS = 3;

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const hash = (...files) => {
  const h = crypto.createHash('sha256');
  for (const f of files) h.update(fs.readFileSync(f));
  return h.digest('hex');
};

function deploy() {
  execFileSync(process.execPath, [path.join(root, 'scripts/build.mjs')], { stdio: 'inherit' });
  const built = readJson(path.join(dist, 'version.json'));
  const current = readJson(pointer);
  const previous = current && readJson(path.join(versions, current.id, 'version.json'));

  // The host is about 90 MB and every machine has to fetch it, so it's only rebuilt when it changed.
  const stagingHost = path.join(dist, 'host', 'fleet-host.exe');
  const reuse = previous?.hostSource === built.hostSource && fs.existsSync(path.join(versions, previous.id, 'fleet-host.exe'));
  if (reuse) fs.copyFileSync(path.join(versions, previous.id, 'fleet-host.exe'), stagingHost);
  else {
    console.log('Packing the host…');
    packHost(root, stagingHost);
  }
  const version = { ...built, host: reuse ? previous.host : hash(stagingHost) };
  version.id = crypto.createHash('sha256').update(`${version.main}${version.preload}${version.renderer}${version.host}`).digest('hex').slice(0, 12);
  if (current?.id === version.id) {
    console.log('Nothing changed.');
    return;
  }

  const dir = path.join(versions, version.id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'renderer'), { recursive: true });
  for (const f of ['main.cjs', 'preload.cjs']) fs.copyFileSync(path.join(dist, f), path.join(dir, f));
  for (const f of fs.readdirSync(path.join(dist, 'renderer'))) fs.copyFileSync(path.join(dist, 'renderer', f), path.join(dir, 'renderer', f));
  fs.copyFileSync(stagingHost, path.join(dir, 'fleet-host.exe'));
  fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify(version, null, 2));

  // Last, and in one step, so the app can never see a half-written version.
  const tmp = `${pointer}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ id: version.id }));
  fs.renameSync(tmp, pointer);
  const changed = previous ? ['main', 'preload', 'renderer', 'host'].filter((k) => previous[k] !== version[k]) : ['everything'];
  console.log(`Deployed ${version.id}: ${changed.join(', ')} changed.`);

  // The running app may still be using an older one, so a few stay.
  const old = fs.readdirSync(versions, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== version.id)
    .map((e) => ({ name: e.name, at: fs.statSync(path.join(versions, e.name)).mtimeMs })).sort((a, b) => b.at - a.at).slice(KEEP_VERSIONS - 1);
  for (const e of old) fs.rmSync(path.join(versions, e.name), { recursive: true, force: true });
}

deploy();
if (process.argv.includes('--watch')) {
  console.log('Watching src for changes.');
  let timer = null;
  fs.watch(path.join(root, 'src'), { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => { try { deploy(); } catch (e) { console.error(e.message); } }, 800);
  });
}
