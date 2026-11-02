// Runs a test that boots real editors: `node scripts/real-test.mjs cli-editors` (no tokens, scripted
// model), `builds` (real compiles), or `real-agents` (the real model, needs a signed-in Claude Code).
// Not part of `npm test`.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const name = process.argv[2] ?? 'cli-editors';
const out = path.join(root, 'dist', `${name}.mjs`);
await build({
  entryPoints: [path.join(root, 'test', `${name}.ts`)],
  outfile: out,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  logLevel: 'warning',
  define: { 'process.env.FLEET_ROOT': JSON.stringify(root) },
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
const r = spawnSync(process.execPath, [out], { stdio: 'inherit' });
process.exit(r.status ?? 1);
