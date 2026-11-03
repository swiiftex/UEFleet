import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { applyChanges, baseText, classify, listChanges, syncProject } from '../src/node/projectSync';

function tmpProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-sync-'));
  const src = path.join(root, 'My Project');
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true });
    fs.writeFileSync(path.join(src, rel), text);
  };
  write('Game.uproject', '{}');
  write('Source/Game/A.cpp', 'line one\nline two\nline three\nline four\nline five\n');
  write('Config/DefaultGame.ini', '[x]\ny=1\n');
  write('Content/Maps/M.umap', 'BINARYMAP');
  write('Content/Hero.uasset', 'BINARYHERO');
  write('Plugins/P/Content/T.uasset', 'PLUGINASSET');
  write('Plugins/P/Source/P.cpp', 'plugin code\n');
  write('Plugins/P/Intermediate/junk.obj', 'junk');
  write('Saved/Logs/old.log', 'skip me');
  write('Intermediate/x.obj', 'skip me');
  write('.plastic/selector', 'skip me');
  write('Binaries/Win64/Game.dll', 'dll');
  return { root, src, dst: path.join(root, 'slot'), write };
}

test('classify keeps editable files real and Content linked', () => {
  assert.equal(classify('Content/Hero.uasset'), 'link');
  assert.equal(classify('Source/Game/A.cpp'), 'copy');
  assert.equal(classify('Config/DefaultGame.ini'), 'copy');
  assert.equal(classify('Plugins/P/Content/T.uasset'), 'link');
  assert.equal(classify('Plugins/P/Source/P.cpp'), 'copy');
  assert.equal(classify('Plugins/P/Intermediate/x'), 'skip');
  assert.equal(classify('Saved/x'), 'skip');
  assert.equal(classify('.plastic/x'), 'skip');
  assert.equal(classify('.mcp.json'), 'skip');
});

test('immutable data is linked wherever it lives, and build outputs stay real copies', () => {
  assert.equal(classify('Plugins/WwiseSoundEngine/ThirdParty/PS5/lib.a'), 'link');
  assert.equal(classify('Wwise/Originals/Ambience/chime.wav'), 'link');
  assert.equal(classify('Wwise/Bank.bnk'), 'link');
  assert.equal(classify('Source/ThirdParty/x/big.lib'), 'link');
  assert.equal(classify('Docs/huge.dat', 50 * 1024 * 1024), 'link');
  assert.equal(classify('Docs/small.dat', 1024), 'copy');
  assert.equal(classify('Source/Game/Generated.h', 50 * 1024 * 1024), 'copy', 'text stays editable at any size');
  assert.equal(classify('Binaries/Win64/UnrealEditor-Game.dll'), 'copy');
  assert.equal(classify('Plugins/P/Binaries/Win64/UnrealEditor-P.dll'), 'copy');
  assert.equal(classify('Binaries/Win64/UnrealEditor-Game.pdb'), 'link');
  assert.equal(classify('Plugins/KiteFlying/.git/objects/pack/x.pack'), 'skip');
});

test('copy hardlinks Content, really copies text, and skips junk', async () => {
  const { src, dst } = tmpProject();
  await syncProject(src, dst);
  assert.equal(fs.statSync(path.join(dst, 'Content/Hero.uasset')).nlink, 2);
  assert.equal(fs.statSync(path.join(dst, 'Plugins/P/Content/T.uasset')).nlink, 2);
  assert.equal(fs.statSync(path.join(dst, 'Source/Game/A.cpp')).nlink, 1);
  assert.equal(fs.statSync(path.join(dst, 'Binaries/Win64/Game.dll')).nlink, 1);
  assert.ok(!fs.existsSync(path.join(dst, 'Saved')));
  assert.ok(!fs.existsSync(path.join(dst, 'Intermediate')));
  assert.ok(!fs.existsSync(path.join(dst, '.plastic')));
  assert.ok(!fs.existsSync(path.join(dst, 'Plugins/P/Intermediate')));
  assert.deepEqual(await listChanges(dst), []);
});

test('editing text in a copy never touches the source', async () => {
  const { src, dst } = tmpProject();
  await syncProject(src, dst);
  fs.appendFileSync(path.join(dst, 'Source/Game/A.cpp'), 'more\n');
  assert.ok(!fs.readFileSync(path.join(src, 'Source/Game/A.cpp'), 'utf8').includes('more'));
});

test('a replaced asset shows as changed and leaves the source and other copies alone', async () => {
  const { src, dst, root } = tmpProject();
  const other = path.join(root, 'slot2');
  await syncProject(src, dst);
  await syncProject(src, other);
  // What UE does on save: write a temp file, then move it over the original.
  fs.writeFileSync(path.join(dst, 'Content/Hero.tmp'), 'CHANGED');
  fs.renameSync(path.join(dst, 'Content/Hero.tmp'), path.join(dst, 'Content/Hero.uasset'));
  assert.equal(fs.readFileSync(path.join(src, 'Content/Hero.uasset'), 'utf8'), 'BINARYHERO');
  assert.equal(fs.readFileSync(path.join(other, 'Content/Hero.uasset'), 'utf8'), 'BINARYHERO');
  const changes = await listChanges(dst);
  assert.deepEqual(changes.map((c) => [c.path.replaceAll('\\', '/'), c.kind, c.binary]), [['Content/Hero.uasset', 'modified', true]]);
});

test('apply copies changes back, including adds and deletes', async () => {
  const { src, dst } = tmpProject();
  await syncProject(src, dst);
  fs.writeFileSync(path.join(dst, 'Source/Game/New.cpp'), 'new file\n');
  fs.rmSync(path.join(dst, 'Config/DefaultGame.ini'));
  fs.appendFileSync(path.join(dst, 'Source/Game/A.cpp'), 'appended\n');
  const r = await applyChanges(dst, src);
  assert.equal(r.conflicts.length, 0);
  assert.equal(r.applied.length, 3);
  assert.equal(fs.readFileSync(path.join(src, 'Source/Game/New.cpp'), 'utf8'), 'new file\n');
  assert.ok(!fs.existsSync(path.join(src, 'Config/DefaultGame.ini')));
  assert.ok(fs.readFileSync(path.join(src, 'Source/Game/A.cpp'), 'utf8').endsWith('appended\n'));
  assert.deepEqual(await listChanges(dst), [], 'applied changes stop showing as changes');
});

test('apply does not write through a hardlink into other copies', async () => {
  const { src, dst, root } = tmpProject();
  const other = path.join(root, 'slot2');
  await syncProject(src, dst);
  await syncProject(src, other);
  fs.writeFileSync(path.join(dst, 'Content/Hero.tmp'), 'FROM SLOT 1');
  fs.renameSync(path.join(dst, 'Content/Hero.tmp'), path.join(dst, 'Content/Hero.uasset'));
  const r = await applyChanges(dst, src);
  assert.equal(r.conflicts.length, 0);
  assert.equal(fs.readFileSync(path.join(src, 'Content/Hero.uasset'), 'utf8'), 'FROM SLOT 1');
  assert.equal(fs.readFileSync(path.join(other, 'Content/Hero.uasset'), 'utf8'), 'BINARYHERO');
});

test('two agents editing different lines of a file both land', async () => {
  const { src, dst, root } = tmpProject();
  const other = path.join(root, 'slot2');
  await syncProject(src, dst);
  await syncProject(src, other);
  const edit = (dir: string, from: string, to: string) => {
    const f = path.join(dir, 'Source/Game/A.cpp');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(from, to));
  };
  edit(dst, 'line one', 'line ONE');
  edit(other, 'line five', 'line FIVE');
  assert.equal((await applyChanges(dst, src)).conflicts.length, 0);
  const second = await applyChanges(other, src);
  assert.equal(second.conflicts.length, 0);
  assert.equal(second.merged.length, 1);
  const final = fs.readFileSync(path.join(src, 'Source/Game/A.cpp'), 'utf8');
  assert.ok(final.includes('line ONE') && final.includes('line FIVE'));
});

test('a merge keeps line endings and non-UTF-8 bytes exactly', async () => {
  const { src, dst, root } = tmpProject();
  const other = path.join(root, 'slot2');
  // CRLF throughout, and a Latin-1 copyright byte that would turn into garbage if decoded as UTF-8.
  const original = Buffer.concat([Buffer.from('[Game]\r\nCopyright='), Buffer.from([0xa9]), Buffer.from(' 2026\r\nA=1\r\nB=2\r\nC=3\r\nD=4\r\nE=5\r\n')]);
  const file = (dir: string) => path.join(dir, 'Config/DefaultGame.ini');
  fs.writeFileSync(file(src), original);
  await syncProject(src, dst);
  await syncProject(src, other);
  fs.writeFileSync(file(dst), Buffer.from(fs.readFileSync(file(dst)).toString('latin1').replace('A=1', 'A=10'), 'latin1'));
  fs.writeFileSync(file(other), Buffer.from(fs.readFileSync(file(other)).toString('latin1').replace('E=5', 'E=50'), 'latin1'));
  assert.equal((await applyChanges(dst, src)).conflicts.length, 0);
  const second = await applyChanges(other, src);
  assert.equal(second.conflicts.length, 0);
  assert.equal(second.merged.length, 1, 'this one really went through the merge');
  const expected = Buffer.from(original.toString('latin1').replace('A=1', 'A=10').replace('E=5', 'E=50'), 'latin1');
  assert.deepEqual(fs.readFileSync(file(src)), expected);
});

test('saves are seeded into a copy and never written back', async () => {
  const { src, dst, write } = tmpProject();
  write('Saved/SaveGames/Progression_1.sav', 'LEVEL 30');
  await syncProject(src, dst);
  const copied = path.join(dst, 'Saved/SaveGames/Progression_1.sav');
  assert.equal(fs.readFileSync(copied, 'utf8'), 'LEVEL 30');
  assert.equal(fs.statSync(copied).nlink, 1, 'a real copy, so the game writing to it cannot reach the source');
  fs.writeFileSync(copied, 'LEVEL 1');
  assert.deepEqual(await listChanges(dst), [], 'never offered for apply');
  assert.equal(fs.readFileSync(path.join(src, 'Saved/SaveGames/Progression_1.sav'), 'utf8'), 'LEVEL 30');
});

test('same line edited twice is a conflict and the source keeps the first edit', async () => {
  const { src, dst, root } = tmpProject();
  const other = path.join(root, 'slot2');
  await syncProject(src, dst);
  await syncProject(src, other);
  const edit = (dir: string, to: string) => {
    const f = path.join(dir, 'Source/Game/A.cpp');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('line three', to));
  };
  edit(dst, 'first agent');
  edit(other, 'second agent');
  await applyChanges(dst, src);
  const second = await applyChanges(other, src);
  assert.equal(second.conflicts.length, 1);
  assert.ok(fs.readFileSync(path.join(src, 'Source/Game/A.cpp'), 'utf8').includes('first agent'));
  const forced = await applyChanges(other, src, undefined, second.conflicts.map((c) => c.path));
  assert.equal(forced.conflicts.length, 0);
  assert.ok(fs.readFileSync(path.join(src, 'Source/Game/A.cpp'), 'utf8').includes('second agent'));
});

test('same binary changed twice is a conflict, not a silent overwrite', async () => {
  const { src, dst, root } = tmpProject();
  const other = path.join(root, 'slot2');
  await syncProject(src, dst);
  await syncProject(src, other);
  for (const [dir, v] of [[dst, 'ONE'], [other, 'TWO']]) {
    fs.writeFileSync(path.join(dir, 'Content/H.tmp'), v);
    fs.renameSync(path.join(dir, 'Content/H.tmp'), path.join(dir, 'Content/Hero.uasset'));
  }
  await applyChanges(dst, src);
  const second = await applyChanges(other, src);
  assert.equal(second.conflicts.length, 1);
  assert.equal(fs.readFileSync(path.join(src, 'Content/Hero.uasset'), 'utf8'), 'ONE');
});

test('resync of a warm copy only touches what changed', async () => {
  const { src, dst, write } = tmpProject();
  await syncProject(src, dst);
  write('Source/Game/A.cpp', 'rewritten\n');
  write('Content/New.uasset', 'NEWASSET');
  const stat = await syncProject(src, dst);
  assert.equal(stat.copied, 1);
  assert.equal(stat.linked, 1);
  assert.ok(stat.skipped >= 5);
  assert.equal(fs.readFileSync(path.join(dst, 'Source/Game/A.cpp'), 'utf8'), 'rewritten\n');
});

test('the private repo tracks only text and never repacks by itself', async () => {
  const { src, dst, write } = tmpProject();
  write('Plugins/Wwise/ThirdParty/x64/lib/AkSoundEngine.lib', 'BIG LIB');
  write('Plugins/Wwise/ThirdParty/ps5/libAkSoundEngine.a', 'BIG LIB');
  write('Plugins/Wwise/Source/AkAudio/Ak.h', 'header\n');
  write('Source/ThirdParty/vendor/tool.exe', 'BIG');
  write('Source/ThirdParty/vendor/noextension', 'BIG');
  write('Source/Game/Mac.mm', 'objc\n');
  write('Wwise/GeneratedSoundBanks/Bank.json', '{}');
  await syncProject(src, dst);
  const git = (...a: string[]) => execFileSync('git', ['-C', dst, ...a], { encoding: 'utf8' }).trim();
  assert.deepEqual(git('ls-files').split('\n').sort(), [
    'Config/DefaultGame.ini',
    'Game.uproject',
    'Plugins/P/Source/P.cpp',
    'Plugins/Wwise/Source/AkAudio/Ak.h',
    'Source/Game/A.cpp',
    'Source/Game/Mac.mm',
  ]);
  assert.equal(git('config', 'gc.auto'), '0', "an agent's own commits don't repack either");
  assert.equal(git('config', 'maintenance.auto'), 'false');
  assert.equal((await baseText(dst, 'Plugins/Wwise/Source/AkAudio/Ak.h'))?.toString(), 'header\n', 'text still has a merge base');
  assert.equal(await baseText(dst, 'Plugins/Wwise/ThirdParty/ps5/libAkSoundEngine.a'), null);
});

test('a copy from before text-only tracking gets a fresh repo', async () => {
  const { src, dst } = tmpProject();
  await syncProject(src, dst);
  const git = (...a: string[]) => execFileSync('git', ['-C', dst, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' }).trim();
  fs.rmSync(path.join(dst, '.git', 'fleet-text-only'));
  fs.writeFileSync(path.join(dst, 'Plugins', 'P', 'Fat.lib'), 'BIG LIB');
  git('add', '-f', 'Plugins/P/Fat.lib');
  git('commit', '-q', '-m', 'what an older version tracked');
  await syncProject(src, dst);
  assert.ok(!git('ls-files').includes('Fat.lib'), 'the libraries are gone from the repo');
  assert.equal(git('rev-list', '--count', '--all'), '1', 'along with their history');
  assert.ok(git('ls-files').includes('Source/Game/A.cpp'));
  const before = git('rev-parse', 'fleet-baseline');
  await syncProject(src, dst);
  assert.notEqual(git('rev-parse', 'HEAD'), '', 'a current repo is kept');
  assert.equal(git('rev-list', '--count', '--all'), '2', 'and only gets a new baseline');
  assert.notEqual(git('rev-parse', 'fleet-baseline'), before);
});

test('a read-only source asset gets a real, writable copy', async () => {
  const { src, dst } = tmpProject();
  const f = path.join(src, 'Content/Hero.uasset');
  fs.chmodSync(f, 0o444);
  try {
    await syncProject(src, dst);
    assert.equal(fs.statSync(path.join(dst, 'Content/Hero.uasset')).nlink, 1);
    fs.appendFileSync(path.join(dst, 'Content/Hero.uasset'), 'x');
    assert.equal(fs.readFileSync(f, 'utf8'), 'BINARYHERO');
  } finally {
    fs.chmodSync(f, 0o666);
  }
});
