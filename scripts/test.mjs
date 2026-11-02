// Tests import app code by bundler-style paths, so bundle them, then run Node's test runner.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'dist', 'test');
fs.rmSync(out, { recursive: true, force: true });
const entries = fs.readdirSync(path.join(root, 'test')).filter((f) => f.endsWith('.test.ts')).map((f) => path.join(root, 'test', f));
await build({
  entryPoints: entries,
  outdir: out,
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  logLevel: 'warning',
  define: { 'import.meta.url': '__import_meta_url', 'process.env.FLEET_ROOT': JSON.stringify(root) },
  banner: { js: "const __import_meta_url = require('url').pathToFileURL(__filename).href;" },
});
const files = fs.readdirSync(out).map((f) => path.join(out, f));
const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
