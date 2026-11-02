// Read-only. Reports what a per-agent copy of a project would cost, without creating anything.
// Usage: node scripts/measure-project.mjs "<folder with the .uproject>"
import fs from 'node:fs/promises';
import path from 'node:path';

const SKIP = new Set(['saved', 'intermediate', 'deriveddatacache', 'backup', '.git', '.plastic', '.svn', '.vs', '.idea', '.vscode', '.codex', '.cursor', '.gemini', '.sentry-native', '.fleet']);
const totals = { linked: [0, 0], copied: [0, 0], binaries: [0, 0] };
const root = process.argv[2];

async function walk(rel) {
  for (const e of await fs.readdir(path.join(root, rel), { withFileTypes: true }).catch(() => [])) {
    const r = rel ? path.join(rel, e.name) : e.name;
    const parts = r.toLowerCase().split(path.sep);
    if (SKIP.has(parts[0])) continue;
    if (parts[0] === 'plugins' && (parts.includes('intermediate') || parts.includes('saved'))) continue;
    if (e.isDirectory()) { await walk(r); continue; }
    if (!e.isFile()) continue;
    const { size } = await fs.stat(path.join(root, r));
    if (parts.includes('.git')) continue;
    const isBin = parts.includes('binaries');
    const lower = r.toLowerCase();
    const text = /\.(cpp|cc|c|h|hpp|inl|cs|py|ini|json|txt|md|uplugin|uproject|xml|ya?ml|usf|ush|hlsl|js|ts|bat|cmd|sh|ps1|toml|csv|tsv|html|css)$/.test(lower);
    const binary = /\.(uasset|umap|ubulk|uexp|upk|png|jpe?g|tga|exr|hdr|bmp|dds|psd|fbx|obj|wav|wem|bnk|mp3|ogg|mp4|mov|dll|so|dylib|exe|pdb|lib|a|prx|prof|exp|bin|pak|zip|7z|gz|ttf|otf)$/.test(lower);
    const linked = lower.endsWith('.pdb') || (!isBin && (parts.includes('content') || (!text && (binary || size >= 4 * 1024 * 1024))));
    const bucket = linked ? 'linked' : isBin ? 'binaries' : 'copied';
    totals[bucket][0]++;
    totals[bucket][1] += size;
  }
}
const t0 = Date.now();
await walk('');
const gb = (n) => (n / 2 ** 30).toFixed(2);
console.log(`Scanned in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`Hardlinked, no extra disk:  ${totals.linked[0]} files, ${gb(totals.linked[1])} GB`);
console.log(`Real copy, text and config: ${totals.copied[0]} files, ${gb(totals.copied[1])} GB`);
console.log(`Real copy, binaries:        ${totals.binaries[0]} files, ${gb(totals.binaries[1])} GB`);
console.log(`Extra disk per agent:       ${gb(totals.copied[1] + totals.binaries[1])} GB`);
