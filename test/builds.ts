// A small C++ project on one engine, through the same code agents use: agents sharing its folder,
// building while another agent's editor stays up, a broken build, and a project sent from the
// master getting copies that compile side by side. Boots real editors and compilers; uses no model.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Slot, SlotManager } from '../src/node/instance';
import { discoverEngines, forgetCopiesFromRecents, readProject } from '../src/node/machine';

const engines = discoverEngines();
const engine = engines.find((e) => e.version.startsWith('5.8.') && !e.source) ?? engines.find((e) => e.version.startsWith('5.8.'))!;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-cpp-'));
const src = path.join(root, 'CppProbe');
const write = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true }); fs.writeFileSync(path.join(src, rel), text); };

write('CppProbe.uproject', JSON.stringify({ FileVersion: 3, EngineAssociation: engine.id, Modules: [{ Name: 'CppProbe', Type: 'Runtime', LoadingPhase: 'Default' }] }));
write('Source/CppProbe.Target.cs', `using UnrealBuildTool;
public class CppProbeTarget : TargetRules { public CppProbeTarget(TargetInfo T) : base(T) { Type = TargetType.Game; DefaultBuildSettings = BuildSettingsVersion.Latest; IncludeOrderVersion = EngineIncludeOrderVersion.Latest; ExtraModuleNames.Add("CppProbe"); } }`);
write('Source/CppProbeEditor.Target.cs', `using UnrealBuildTool;
public class CppProbeEditorTarget : TargetRules { public CppProbeEditorTarget(TargetInfo T) : base(T) { Type = TargetType.Editor; DefaultBuildSettings = BuildSettingsVersion.Latest; IncludeOrderVersion = EngineIncludeOrderVersion.Latest; ExtraModuleNames.Add("CppProbe"); } }`);
write('Source/CppProbe/CppProbe.Build.cs', `using UnrealBuildTool;
public class CppProbe : ModuleRules { public CppProbe(ReadOnlyTargetRules T) : base(T) { PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs; PublicDependencyModuleNames.AddRange(new[] { "Core", "CoreUObject", "Engine" }); } }`);
write('Source/CppProbe/CppProbe.h', '#pragma once\n#include "CoreMinimal.h"\nint32 ProbeValue();\n');
const cppFile = path.join(src, 'Source/CppProbe/CppProbe.cpp');
const cpp = (value: number, extra = '') => `#include "CppProbe.h"\n#include "Modules/ModuleManager.h"\nIMPLEMENT_PRIMARY_GAME_MODULE(FDefaultGameModuleImpl, CppProbe, "CppProbe");\nint32 ProbeValue() { return ${value}; }\n${extra}`;
write('Source/CppProbe/CppProbe.cpp', cpp(1));

const results: string[] = [];
const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s]`, ...a);
const check = (name: string, ok: boolean, info?: unknown) => {
  results.push(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  log(ok ? 'ok  ' : 'FAIL', name, ok || info === undefined ? '' : String(typeof info === 'string' ? info : JSON.stringify(info)).slice(-1500));
};
const isPie = (s: Slot) => s.mcp.tool('call_tool', { toolset_name: 'EditorToolset.EditorAppToolset', tool_name: 'IsPIERunning', arguments: {} });

const project = readProject(path.join(src, 'CppProbe.uproject'), engines)!;
const mgr = new SlotManager('test', path.join(root, 'data'), os.cpus().length, 4);
mgr.builds.limit = 2;
log(`Engine ${engine.version} at ${engine.root}`);

const dll = path.join(src, 'Binaries/Win64/UnrealEditor-CppProbe.dll');

log('Two agents in the same folder');
const a: Slot = await mgr.acquire(project, engine, 'a', 'headless');
const b: Slot = await mgr.acquire(project, engine, 'b', 'headless');
check('both work in the project itself', a.dir === src && b.dir === src && a.shared && b.shared);
check('and nothing was added to it', !fs.existsSync(path.join(src, '.fleet')));

log('Both ask to build at once');
const startedAt = Date.now();
const [ra, rb] = await Promise.all([a.build({}), b.build({})]);
const first = Math.max(ra.ms, rb.ms);
check('the first build compiled', ra.ok, ra.output);
check('the second, queued behind it, also succeeded', rb.ok, rb.output);
check('and found nothing left to do', Math.min(ra.ms, rb.ms) < first / 2, { a: ra.ms, b: rb.ms });
log(`  total ${Math.round((Date.now() - startedAt) / 1000)}s, compile ${Math.round(first / 1000)}s, the one behind it ${Math.round(Math.min(ra.ms, rb.ms) / 1000)}s`);
check('the build went into the project', fs.existsSync(dll));

log('A build while another editor stays up');
await a.ensureEditor('headless');
check("A's editor boots from the shared folder", a.state === 'ready' && a.isRunning, a.state);
await isPie(a);
const aPid = a.pid;
let writable = true;
try { fs.writeFileSync(dll, fs.readFileSync(dll)); } catch { writable = false; }
check('its module really is locked', !writable);
const editorLog = await a.tail(5000);
// The build tool keeps a settings file in the project's Saved, as it does for anyone's build.
const projectSaved = fs.readdirSync(path.join(src, 'Saved'));
check("its Saved folder is its own, and it wrote nothing to the project's", fs.existsSync(path.join(a.own, 'Saved/Logs')) && projectSaved.join() === 'UnrealBuildTool', projectSaved);
check('the command line carries it', /UserDir=/.test(editorLog), editorLog.split('\n').find((l) => l.includes('commandline=')));

fs.writeFileSync(cppFile, cpp(2));
const dllBefore = fs.statSync(dll).mtimeMs;
const during = await b.build({});
check("B's build succeeds while A's editor has the module loaded", during.ok, during.output);
check('it really relinked the module', fs.statSync(dll).mtimeMs > dllBefore);
check("A's editor is still the same process", a.isRunning && a.pid === aPid, [a.pid, aPid]);
const stillAnswers = JSON.stringify(await isPie(a));
check('and still answers', stillAnswers.includes('false'), stillAnswers);
check('A is told a newer build exists', a.sharing().newerBuildThanYourEditor === true, a.sharing());
const aside = fs.readdirSync(path.dirname(dll)).filter((f) => f.includes('.fleet-old-'));
check("the module A loaded was moved aside", aside.length >= 1, fs.readdirSync(path.dirname(dll)));

log('A build with nothing to do leaves the module alone, even with one loaded');
await b.ensureEditor('headless');
check("B's editor boots with the new module", b.state === 'ready' && /CppProbe/.test(await b.tail(400, 'CppProbe')), b.state);
const c: Slot = await mgr.acquire(project, engine, 'c', 'headless');
const dllDate = fs.statSync(dll).mtimeMs;
const noop = await c.build({});
check('the build succeeds', noop.ok, noop.output);
check('and the module was not relinked', fs.statSync(dll).mtimeMs === dllDate, { before: dllDate, after: fs.statSync(dll).mtimeMs });
check('nothing needed compiling', /up to date|Total execution time/i.test(noop.output) && noop.ms < during.ms * 3, noop.output);

log('A compile error is reported, and running editors are unaffected');
fs.writeFileSync(cppFile, cpp(2, '\nthis does not compile;\n'));
const bad = await c.build({});
check('the broken build fails', !bad.ok);
check('and its output names the error', /CppProbe\.cpp.*error|error.*CppProbe\.cpp|error C/i.test(bad.output), bad.output);
check("A's editor still answers", JSON.stringify(await isPie(a)).includes('false'));
fs.writeFileSync(cppFile, cpp(3));
const fixed = await c.build({});
check('and fixing it builds again', fixed.ok, fixed.output);

log('Leftovers clear up');
await a.stopEditor();
await b.stopEditor();
await new Promise((r) => setTimeout(r, 1000));
await c.build({});
check('a later build removes the modules nothing has loaded any more', fs.readdirSync(path.dirname(dll)).filter((f) => f.includes('.fleet-old-')).length === 0, fs.readdirSync(path.dirname(dll)));

log('A project sent from the master still gets copies, compiling at the same time');
fs.rmSync(path.join(src, 'Binaries'), { recursive: true, force: true });
fs.rmSync(path.join(src, 'Intermediate'), { recursive: true, force: true });
const sent = { ...project, received: true };
const x: Slot = await mgr.acquire(sent, engine, 'x', 'headless');
const y: Slot = await mgr.acquire(sent, engine, 'y', 'headless');
const copiesAt = Date.now();
const [rx, ry] = await Promise.all([x.build({}), y.build({})]);
const wall = Date.now() - copiesAt;
check('copy X compiled', rx.ok, rx.output);
check('copy Y compiled', ry.ok, ry.output);
check('they ran at the same time rather than queueing', wall < (rx.ms + ry.ms) * 0.85, { wall, x: rx.ms, y: ry.ms });
check('each copy has its own binaries', fs.existsSync(path.join(x.dir, 'Binaries/Win64')) && fs.existsSync(path.join(y.dir, 'Binaries/Win64')));
check('nothing was built into the source project', !fs.existsSync(path.join(src, 'Binaries')) && !fs.existsSync(path.join(src, 'Intermediate')));

await mgr.shutdown();
// Marked as a copy so this throwaway project drops off Unreal's recent list.
fs.mkdirSync(path.join(src, '.fleet'), { recursive: true });
forgetCopiesFromRecents(engine.version);
const failed = results.filter((r) => r.startsWith('FAIL'));
console.log(`\n${results.join('\n')}\n\n${results.length - failed.length}/${results.length} passed`);
setTimeout(() => process.exit(failed.length ? 1 : 0), 300);
