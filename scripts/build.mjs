// Bundles the master app (Electron main, preload, UI) and the standalone remote host.
import { build } from 'esbuild';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
fs.mkdirSync(path.join(dist, 'renderer'), { recursive: true });

// The Agent SDK is ESM and reads import.meta.url; these bundles are CommonJS.
const node = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  logLevel: 'warning',
  define: { 'import.meta.url': '__import_meta_url' },
  banner: { js: "const __import_meta_url = require('url').pathToFileURL(__filename).href;" },
};

await Promise.all([
  build({ ...node, entryPoints: [path.join(root, 'src/main/loader.ts')], outfile: path.join(dist, 'loader.cjs'), external: ['electron', './main.cjs'] }),
  build({ ...node, entryPoints: [path.join(root, 'src/main/main.ts')], outfile: path.join(dist, 'main.cjs'), external: ['electron'] }),
  build({ ...node, entryPoints: [path.join(root, 'src/main/preload.ts')], outfile: path.join(dist, 'preload.cjs'), external: ['electron'], banner: {}, define: {} }),
  // Single-executable Node can't do dynamic import() at runtime, so everything becomes require().
  build({ ...node, entryPoints: [path.join(root, 'src/host/main.ts')], outfile: path.join(dist, 'host', 'fleet-host.cjs'), supported: { 'dynamic-import': false } }),
  build({
    entryPoints: [path.join(root, 'src/renderer/main.tsx'), path.join(root, 'src/renderer/styles.css')],
    outdir: path.join(dist, 'renderer'),
    entryNames: '[ext]',
    bundle: true,
    platform: 'browser',
    target: 'chrome130',
    jsx: 'automatic',
    logLevel: 'warning',
    define: { 'process.env.NODE_ENV': '"production"' },
    minify: true,
  }),
]);
// esbuild names the outputs by extension; the page expects app.js and app.css.
fs.renameSync(path.join(dist, 'renderer', 'js.js'), path.join(dist, 'renderer', 'app.js'));
fs.renameSync(path.join(dist, 'renderer', 'css.css'), path.join(dist, 'renderer', 'app.css'));
fs.copyFileSync(path.join(root, 'src/renderer/index.html'), path.join(dist, 'renderer', 'index.html'));

// What's in this build, so a new version can be compared part by part.
const hash = (...files) => {
  const h = crypto.createHash('sha256');
  for (const f of files) h.update(fs.readFileSync(path.join(dist, f)));
  return h.digest('hex');
};
fs.writeFileSync(path.join(dist, 'version.json'), JSON.stringify({
  id: 'built-in',
  main: hash('main.cjs'),
  preload: hash('preload.cjs'),
  renderer: hash('renderer/app.js', 'renderer/app.css', 'renderer/index.html'),
  hostSource: hash('host/fleet-host.cjs'),
}, null, 2));
console.log('Built.');
