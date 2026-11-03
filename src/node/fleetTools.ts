// The tools each agent gets. They are bound to that agent's own instance, so there is no
// port or path to get wrong and no way to reach another agent's editor.
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { FinalReport, HumanTest } from '../shared/protocol';
import type { Slot } from './instance';

// Without this the CLI hides MCP tools behind tool search, and an agent could miss finish_task.
const always: typeof tool = (name, description, schema, handler) => tool(name, description, schema, handler, { alwaysLoad: true });

const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }], isError });

export const FLEET_TOOLS = [
  'ue_status', 'ue_list_toolsets', 'ue_describe_toolset', 'ue_call', 'ue_build', 'ue_run_tests',
  'ue_launch_game', 'ue_stop_games', 'ue_log', 'ue_crash', 'ue_stop', 'report_progress', 'ask_master', 'finish_task',
].map((n) => `mcp__fleet__${n}`);

const SHARED_FOLDER = (slot: Slot) => `You're working directly in the user's project at ${slot.dir}. Other agents on this machine work in the same files, and the user may be too. Whatever you save is in their workspace straight away, with nothing to apply afterwards. Your own editor keeps its logs, settings and saves in ${slot.own}, so you never queue for Play In Editor.`;
const PRIVATE_COPY = (slot: Slot) => `You have a private copy of the project at ${slot.dir} and your own editor instance. Other agents have their own, so you never queue for a build or for Play In Editor. Nothing here touches the user's real project until the user applies your changes, so test freely.`;

const SHARED_BUILD = "ue_build compiles the project, and builds of it run one at a time, so it may wait for another agent's. It stops your editor first, and the next ue_call boots it again. Other editors keep running the code they started with: ue_status says when a newer build than your editor's exists, and ue_stop followed by any ue_call picks it up.";
const COPY_BUILD = 'ue_build compiles your copy. It stops your editor first, and the next ue_call boots it again.';

const SHARED_RULES = `
Because these files are shared:
- Never run anything that reverts, resets, stashes, cleans, switches or updates the workspace, such as git checkout, reset, stash or clean, cm undo, switch or update, or p4 revert or sync. It would destroy uncommitted work belonging to the user and to other agents. Don't check in or commit unless the user asks, and then name only the files you changed, because a plain check-in would take everyone else's work with it.
- Change only what your task needs. Changes you didn't make aren't yours to fix or undo. ue_status lists who else is working here and on what.
- If a build fails in code you didn't touch, another agent is probably part way through an edit. Wait a couple of minutes and build again before doing anything about it.
- When two agents save the same asset, the last save wins and the other's work is lost with no warning. Check ue_status before changing an asset others are likely to need, such as a map, and if your editor has had an asset open for a while, reload it before changing it.
- A read-only file is locked by source control. Check it out with the project's own tool, such as p4 edit, instead of clearing the flag.
- If a build says Live Coding is active, the user has the project open in their own editor. Tell them, and wait for them to close it or turn Live Coding off.
`;

export function appendPrompt(slot: Slot | null, projectNotes?: string) {
  const instance = slot ? `
# Your Unreal instance
${slot.shared ? SHARED_FOLDER(slot) : PRIVATE_COPY(slot)}

Use the mcp__fleet tools for all Unreal work:
- ue_list_toolsets, ue_describe_toolset and ue_call drive your editor (Play In Editor, logs, screenshots, assets, automation). The editor boots on first use and restarts itself after a crash or a build.
- ${slot.shared ? SHARED_BUILD : COPY_BUILD} If it fails because it would modify engine files, the engine itself needs a rebuild that only the user can do. Don't work around that: say so in your final message.
- ue_run_tests runs automation tests in a separate process. Pass render true for tests that need a GPU, such as visual or flow tests. ue_launch_game starts real standalone game processes, including a listen server with clients for networking checks.
- ue_log reads your editor log and ue_crash reports the newest crash with its callstack.

Don't start UnrealEditor, Build.bat or UnrealBuildTool yourself. ${slot.shared ? 'Your own Saved/SaveGames' : "There is a git repository over this copy's text files, so git diff shows your code changes. Saved/SaveGames"} starts as a copy of the user's saves, and nothing you do to it reaches the real ones.
${slot.shared ? SHARED_RULES : ''}
The project's CLAUDE.md and memory notes were mostly written for someone working in the real project with one shared editor. They still apply for code, gameplay and test knowledge, but these rules win wherever they disagree:
- Anything that reaches an editor on a fixed port or through remote Python execution, such as a helper script or a port number in the notes, reaches the user's own editor and could cost them work. Use only the ue_ tools, which always reach yours.
- ${slot.shared ? "Your editor is yours alone, and a build doesn't disturb anyone else's. Rebuild and restart whenever you need to, without asking, and don't coordinate with other sessions about it." : "This copy and this editor are yours alone. Rebuild and restart them whenever you need to, without asking, and don't coordinate with other sessions about them."}
- Notes you save go into the real project's memory, so only write what's true for the real project${slot.shared ? ', not details of your own instance' : ', not details of this copy'}.
` : '';
  const notes = projectNotes ? `\n# Notes for this project\n${projectNotes}\n` : '';
  return `${instance}${notes}
# Progress
Your card shows a progress bar. Call report_progress with a rough percentage of the whole task as soon as you have a sense of its size, then again at each real step forward, such as finding the cause, getting a build through or passing a test. Don't call it after every small action. A rough guess is fine, and it can go down if the job turns out bigger. You don't need to reach 100, because finish_task fills the bar. If the user gives you more to do after you've finished, the bar starts again, so report on the new work.

# Asking the master
This machine may not be logged into Jira, Codevelop or the other services the user works with, and your tools here can't reach them. The master chat, on the user's main PC, can. When you need a ticket, a design note or anything else from those, call ask_master with a specific question instead of guessing. It waits for the answer, which may take a while if the master has to ask the user. Use AskUserQuestion for decisions only the user can make.

# Finishing
When the task is done, call finish_task. Until you call it the user sees you as waiting on them, so end a turn without it only when you need something from them.

Test everything you can yourself first, and list what you checked in verified. needs_human_testing is the user's checklist, so keep it to what you really couldn't check: how something feels to play, how it looks or sounds, animation quality, behaviour between real machines. Leave it empty when your own checks prove the change works, as with a crash you reproduced and then confirmed gone, a compile fix, or passing automation tests.

Each checklist item has to stand on its own. The user may be testing several tasks at once and hasn't watched you work, so say exactly where to go, what to do and what they should see. List every file you changed in files_changed, because that decides what gets merged and what goes into the changelist.

The user may send your work back with what they found. Fix it, test what you can, and call finish_task again with a fresh checklist.`;
}

// The editor's tools return images as base64 inside JSON text. Handing that to the model as text
// is huge and useless, so lift them out into real image blocks it can actually see.
export function liftImages(result: any) {
  const content: any[] = [];
  for (const block of result?.content ?? []) {
    if (block.type !== 'text' || !block.text?.includes('"data"')) { content.push(block); continue; }
    let parsed: any;
    try { parsed = JSON.parse(block.text); } catch { content.push(block); continue; }
    const images: any[] = [];
    const walk = (node: any) => {
      if (!node || typeof node !== 'object') return;
      if (typeof node.data === 'string' && typeof node.mimeType === 'string' && node.mimeType.startsWith('image/') && node.data.length > 64) {
        images.push({ type: 'image', data: node.data, mimeType: node.mimeType });
        node.data = '(see the attached image)';
        return;
      }
      for (const v of Array.isArray(node) ? node : Object.values(node)) walk(v);
    };
    walk(parsed);
    content.push({ type: 'text', text: images.length ? JSON.stringify(parsed) : block.text }, ...images);
  }
  return { ...result, content };
}

export function fleetServer(slot: Slot | null, onFinish: (r: FinalReport) => void, onProgress: (percent: number) => void, askMaster: (question: string) => Promise<string>) {
  const needSlot = () => {
    if (!slot) throw new Error('This task has no Unreal project attached.');
    return slot;
  };
  const guarded = <A,>(fn: (a: A) => Promise<any>) => async (a: A) => {
    try { return await fn(a); } catch (e: any) { return text(String(e?.message ?? e), true); }
  };
  const callMcp = async (name: string, args: Record<string, unknown>) => {
    const s = needSlot();
    await s.ensureEditor();
    s.touch();
    const r = await s.mcp.tool(name, args);
    s.touch();
    return r;
  };

  return createSdkMcpServer({
    name: 'fleet',
    version: '1.0.0',
    tools: [
      always('ue_status', 'State of your Unreal instance: project location, engine, editor state, and who else is working in the same project folder.', {}, guarded(async () => {
        const s = needSlot();
        return text(JSON.stringify({ project: s.projectFile, engine: s.engine?.version ?? null, engineRoot: s.engine?.root ?? null, state: s.state, detail: s.detail, mode: s.mode, editorLog: s.logFile, nativeMcp: !!s.engine?.hasMcp, ...s.sharing() }, null, 2));
      })),
      always('ue_list_toolsets', 'List the toolsets of your editor. Boots the editor if it is not running.', {}, guarded(async () => callMcp('list_toolsets', {}))),
      always('ue_describe_toolset', 'Get the tools and input schemas of one toolset in your editor.', { toolset_name: z.string() }, guarded(async (a) => callMcp('describe_toolset', a))),
      always('ue_call', 'Call a tool in your editor. Find names with ue_list_toolsets and ue_describe_toolset. Examples: EditorToolset.EditorAppToolset StartPIE, IsPIERunning, StopPIE, CaptureViewport; EditorToolset.LogsToolset for logs. These tools want every parameter passed, including optional ones, so check ue_describe_toolset first.', {
        toolset_name: z.string().optional(),
        tool_name: z.string(),
        arguments: z.record(z.string(), z.any()).optional(),
      }, guarded(async (a) => {
        const s = needSlot();
        await s.ensureEditor();
        if (a.tool_name === 'StartPIE') s.setState('pie');
        const r = await callMcp('call_tool', { toolset_name: a.toolset_name, tool_name: a.tool_name, arguments: a.arguments ?? {} });
        if (a.tool_name === 'StopPIE' || (a.tool_name === 'StartPIE' && r?.isError)) s.setState('ready');
        return liftImages(r);
      })),
      always('ue_build', 'Compile the project. Stops your editor first. Returns the errors and the end of the output.', {
        target: z.string().optional().describe('Defaults to <Project>Editor.'),
        config: z.string().optional().describe('Defaults to Development.'),
      }, guarded(async (a) => {
        const r = await needSlot().build(a);
        return text(`${r.ok ? 'BUILD SUCCEEDED' : 'BUILD FAILED'} in ${Math.round(r.ms / 1000)}s\n${r.output}`, !r.ok);
      })),
      always('ue_run_tests', 'Run automation tests in a separate process. Filter is a test name prefix, for example "Project.Gameplay". Set render true for tests that need a GPU; leave it off for unit tests, which run faster without one.', {
        filter: z.string(),
        render: z.boolean().optional(),
      }, guarded(async (a) => {
        const r = await needSlot().runTests(a.filter, a.render);
        return text(`${r.ok ? 'TESTS PASSED' : 'TESTS FAILED'}\n${r.output}\n${r.report ? `Report: ${r.report.slice(0, 20000)}` : ''}`, !r.ok);
      })),
      always('ue_launch_game', 'Start standalone game processes. With server true, starts a listen server plus count clients connected to it. Each writes its own log, which it returns.', {
        map: z.string().optional(),
        count: z.number().int().optional(),
        server: z.boolean().optional(),
        extraArgs: z.string().optional(),
      }, guarded(async (a) => text(JSON.stringify(await needSlot().launchGame(a), null, 2)))),
      always('ue_stop_games', 'Stop game processes started with ue_launch_game.', {}, guarded(async () => { needSlot().stopGames(); return text('Stopped.'); })),
      always('ue_log', 'Read the end of your editor log, optionally filtered by a regular expression.', {
        lines: z.number().int().optional(),
        grep: z.string().optional(),
      }, guarded(async (a) => text(await needSlot().tail(a.lines ?? 80, a.grep)))),
      always('ue_crash', 'Newest crash in your instance: error message, callstack and log errors.', {}, guarded(async () => text(await needSlot().crashInfo()))),
      always('ue_stop', 'Stop your editor to free its place for other agents. It boots again when needed.', {}, guarded(async () => { await needSlot().stopEditor(); return text('Stopped.'); })),
      always('report_progress', 'Say roughly how far through the whole task you are. It shows as a progress bar on your card.', {
        percent: z.number().min(0).max(100).describe('Rough percentage of the whole task done so far.'),
      }, guarded(async (a) => { onProgress(a.percent); return text('Recorded.'); })),
      always('ask_master', "Ask the master chat for something this machine can't reach, such as a Jira ticket or a Codevelop note. Waits for the answer.", {
        question: z.string().describe('What you need, specifically enough to answer without further context. Name any ticket or document.'),
      }, guarded(async (a) => text(await askMaster(a.question)))),
      always('finish_task', 'Report that the task is done. The user sees this as your final message.', {
        summary: z.string().describe('One or two sentences on what changed.'),
        files_changed: z.array(z.string()).optional().describe("Every file you changed, created or deleted in the project, including through scripts or your editor. Other agents' changes don't belong here."),
        verified: z.array(z.string()).describe('What you checked yourself, and how.'),
        needs_human_testing: z.array(z.object({
          what: z.string().describe('A few words naming the check, shown as a checklist item.'),
          how: z.string().describe('Exact steps for someone who has not followed this task: which map or menu, what to do, in what order.'),
          expect: z.string().describe('What they should see if it works, so they know when to tick it.'),
          why: z.string().optional().describe('Why you could not check it yourself.'),
        })).describe('Only what you could not check instantly and reliably yourself. Empty when your own checks prove it works.'),
      }, guarded(async (a) => {
        for (const f of a.files_changed ?? []) slot?.noteChanged(f, 'reported');
        onFinish({ summary: a.summary, verified: a.verified, needsTesting: a.needs_human_testing as HumanTest[], at: Date.now() });
        return text('Recorded. Stop here unless the user replies.');
      })),
    ],
  });
}
