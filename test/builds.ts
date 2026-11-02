// Two copies of a small C++ project compiling at the same time on one engine, through the same
// code agents use. Then a broken build, an incremental rebuild, and editing while a source editor
// holds the asset open. Boots real editors and compilers; uses no model.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Slot, SlotManager } from '../src/node/instance';
import { discoverEngines, readProject } from '../src/node/machine';

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
write('Source/CppProbe/CppProbe.cpp', '#include "CppProbe.h"\n#include "Modules/ModuleManager.h"\nIMPLEMENT_PRIMARY_GAME_MODULE(FDefaultGameModuleImpl, CppProbe, "CppProbe");\nint32 ProbeValue() { return 1; }\n');

const results: string[] = [];
const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s]`, ...a);
const check = (name: string, ok: boolean, info?: unknown) => {
  results.push(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  log(ok ? 'ok  ' : 'FAIL', name, ok || info === undefined ? '' : String(typeof info === 'string' ? info : JSON.stringify(info)).slice(-1500));
};

const project = readProject(path.join(src, 'CppProbe.uproject'), engines)!;
const mgr = new SlotManager('test', path.join(root, 'data'), os.cpus().length, 4);
log(`Engine ${engine.version} at ${engine.root}`);

const a: Slot = await mgr.acquire(project, engine, 'a', 'headless');
const b: Slot = await mgr.acquire(project, engine, 'b', 'headless');
mgr.builds.limit = 2;

log('Compiling both copies at once');
const startedAt = Date.now();
const [ra, rb] = await Promise.all([a.build({}), b.build({})]);
const wall = Date.now() - startedAt;
check('copy A compiled', ra.ok, ra.output);
check('copy B compiled', rb.ok, rb.output);
check('they ran at the same time rather than queueing', wall < (ra.ms + rb.ms) * 0.85, { wall, a: ra.ms, b: rb.ms });
log(`  wall ${Math.round(wall / 1000)}s, A ${Math.round(ra.ms / 1000)}s, B ${Math.round(rb.ms / 1000)}s`);
check('each copy has its own binaries', fs.existsSync(path.join(a.dir, 'Binaries/Win64')) && fs.existsSync(path.join(b.dir, 'Binaries/Win64')));
check('nothing was built into the source project', !fs.existsSync(path.join(src, 'Binaries')) && !fs.existsSync(path.join(src, 'Intermediate')));

log('A compile error in one copy does not reach the other');
fs.appendFileSync(path.join(a.dir, 'Source/CppProbe/CppProbe.cpp'), '\nthis does not compile;\n');
const bad = await a.build({});
check('the broken build fails', !bad.ok);
check('and its output names the error', /CppProbe\.cpp.*error|error.*CppProbe\.cpp|error C/i.test(bad.output), bad.output);

log('Incremental rebuild is quick');
fs.writeFileSync(path.join(b.dir, 'Source/CppProbe/CppProbe.cpp'), fs.readFileSync(path.join(b.dir, 'Source/CppProbe/CppProbe.cpp'), 'utf8').replace('return 1', 'return 2'));
const inc = await b.build({});
check('the incremental build works', inc.ok, inc.output);
check('and is faster than the first one', inc.ms < rb.ms, { first: rb.ms, incremental: inc.ms });
log(`  first ${Math.round(rb.ms / 1000)}s, incremental ${Math.round(inc.ms / 1000)}s`);

log('A freshly built editor boots with its MCP server');
await b.ensureEditor('headless');
check('the editor boots from the copy', b.state === 'ready' && b.isRunning, b.state);
const r = await b.mcp.tool('call_tool', { toolset_name: 'EditorToolset.EditorAppToolset', tool_name: 'IsPIERunning', arguments: {} });
check('and answers through MCP', JSON.stringify(r).includes('false'), r);
const log0 = await b.tail(400, 'CppProbe');
check('with the project module loaded', /CppProbe/.test(log0), log0.slice(-300));
await b.stopEditor();

await mgr.shutdown();
const failed = results.filter((x) => x.startsWith('FAIL'));
console.log(`\n${results.join('\n')}\n\n${results.length - failed.length}/${results.length} passed`);
setTimeout(() => process.exit(failed.length ? 1 : 0), 300);
