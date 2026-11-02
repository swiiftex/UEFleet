# UE Fleet

Run many Claude agents on an Unreal project at once. Each agent gets its own copy of the project and its own editor, so nobody waits for a build or for Play In Editor.

## Run it

```bash
claude auth login
npm install
npm start
```

`npm run demo` starts it with scripted agents, which use no tokens and no Unreal.

## Keys

| Key | Does |
|---|---|
| `Tab` | With a popup showing: jump to that chat |
| `Esc` | Put the popup away, close a window, or interrupt the selected agent |
| `Shift+Enter` | Message all agents, from anywhere |
| `1` `2` `3` | Answer a permission prompt or question when the message box is empty |
| `Ctrl+N` | New task. If what you type matches a card, `Alt+1`…`3` sends it there instead |
| `Ctrl+1`…`9` | Jump to a card |
| `Enter` / `Ctrl+Enter` | Send / new line in the message box |

## How an instance works

A new task copies the project for its agent. Content and other files that never change in place are hardlinked, so they cost no disk. Source, config and build outputs are real copies. Night Crew measures 94 GB linked and 1.5 GB copied per agent. Run `node scripts/measure-project.mjs <project folder>` to see the numbers for another project.

UE saves an asset by replacing the file, so a save in one copy never reaches another copy or your project. The copy is kept after the task, so the next task on that project starts with its build outputs in place.

Each editor gets its own MCP port, PIE port and log through command-line overrides, and your project files aren't edited to do it. Agents reach their editor through their own tools, and `strictMcpConfig` keeps every other MCP server away from them, including anything that could reach your real editor.

Running editors are capped per machine (4 on this PC, editable under Machines). An agent past the cap keeps working on code and only waits when it needs an editor. Idle editors stop after 10 minutes and start again on the next use.

Editor modes: **offscreen** has no window but still renders, **headless** doesn't render at all, and **windowed** is a normal editor you can look at. Audio stays on in every mode so audio features can be tested. The engine outputs silence while unfocused, so instances stay quiet on your speakers.

On a source-built engine, `ue_build` passes `-NoEngineChanges`, so an agent's build fails instead of relinking engine DLLs under every running editor.

## Getting the work back

Changes stay in the agent's copy until you open the card's **Changes** tab and press **Apply**. A file that also changed in your project gets a three-way merge if it's text, and is reported as a conflict if it's binary or the merge fails. This doesn't depend on your version control, so it works the same with Plastic, Perforce, git or nothing.

Archiving a card frees its copy for reuse, and it warns you first if anything hasn't been applied.

Each file has a checkbox. **Apply all finished**, in the tests window, does every finished card at once and reports what it couldn't apply. Merges work on bytes, so line endings and non-UTF-8 characters survive.

## Per-project settings

Put an optional `.uefleet.json` beside the `.uproject` for what only that project knows:

```json
{
  "startupMap": "/Game/Maps/L_Test_ItemTesting",
  "editorArgs": "-SomeFlag",
  "gameArgs": "-AnotherFlag",
  "neverApply": ["Config/DefaultGame.ini"],
  "agentNotes": "StartPIE must only be called once per session. Retries have crashed the editor.",
  "mcpServers": { "tickets": { "type": "http", "url": "https://example.com/mcp" } }
}
```

| Setting | Does |
|---|---|
| `startupMap` | The map the editor opens |
| `editorArgs`, `gameArgs` | Extra arguments for editors and for standalone games |
| `neverApply` | Files that start unticked on the Changes tab, and that **Apply all finished** leaves out |
| `agentNotes` | Added to every agent's instructions |
| `mcpServers` | Extra MCP servers for agents. Nothing else gets through, so a server that reaches your real editor would defeat the isolation |

## Project notes and saves

Agents in a copy read and write the real project's Claude memory, so they keep what you've taught them. Their instructions say the instance rules win over notes written for one shared editor, such as anything that reaches an editor on a fixed port.

`Saved/SaveGames` is copied into each new copy, so agents start from your progress instead of a first run. Nothing they do to it comes back.

## Final messages

Agents finish by calling `finish_task` with what they checked themselves and what needs a person. If nothing needs a person, the card just goes to FINISHED with no popup. Otherwise you get a final message and a popup, and the items go on the **tests** list. When everything's done and tests remain, a popup offers the list. An agent that reports it verified nothing still gets a popup, however confident it sounds.

## Linking other machines

Remote machines run `fleet-host.exe`, one file with no UI. The master keeps the cards, chats and decisions. The agents, the project copies and the editors all run on the remote machine.

1. Run `npm run package` on the master. It writes `release/fleet-host.exe` and `release/UE Fleet-win32-x64/`.
2. Copy `fleet-host.exe` to the other machine. It needs Claude Code signed in there, plus the same Unreal version as the project. A C++ project also needs Visual Studio, because the first build happens there.
3. Open **machines** on the master, copy the pairing code, then run this on the other machine:

```bash
fleet-host.exe --pair <code>
```

It reconnects by itself after that. A project goes to the remote the first time a task needs it, and only changes are sent afterwards. If that machine already has a project with the same name in its recent list, for example your own Plastic workspace, that copy is used and nothing is sent. Debug symbols are skipped when sending.

### Engines

The host and the master both find launcher installs and any build registered with Windows. To register a custom or source build, run this from the engine's top folder, on the machine it's on:

```bash
Engine\Binaries\Win64\UnrealVersionSelector-Win64-Shipping.exe /register
```

An installed build calls it `UnrealVersionSelector.exe`. Registering also lists the build in the **Switch Unreal Engine version** menu. To point only the host at a folder instead:

```bash
fleet-host.exe --engine "D:\UE\MyBuild"
```

`--remove-engine` undoes that. Either way, restart the host afterwards, since it looks for engines when it starts. Its first lines list each engine it found and why it rejected any others, and **machines** on the master shows the same. An engine must be UE5 with its Development editor built. A project tied to a custom build gets a custom build of the same major and minor version on that machine, ahead of a stock engine.

### Security

The host dials out to the master, so only the master listens on a port (47800). The connection is TLS, and the host pins the master's certificate from the pairing code. Anyone with a pairing code can link a machine to your master, so treat it like a password. **New code** replaces it.

### VMs

A VM is just another machine: install Windows, Unreal and Claude Code in it, run `fleet-host.exe`, and it joins like the laptop. Process instances on the same PC use far less memory for the same parallel PIE, so use a VM when you need the separation itself.

## Tests

```bash
npm test
npm run test:ui
node scripts/real-test.mjs cli-editors
node scripts/real-test.mjs builds
node scripts/real-test.mjs real-agents
```

| Test | Covers | Needs |
|---|---|---|
| `npm test` | Copying, merging, the hub, and a real host process over TLS | Nothing |
| `npm run test:ui` | The real app with real key presses and scripted agents | Nothing |
| `cli-editors` | The real Claude CLI and real editors, with a scripted API in place of the model | UE 5.8 |
| `builds` | Two copies of a C++ project compiling at once | UE 5.8, Visual Studio |
| `real-agents` | The real model on the cheapest tier | UE 5.8, a Claude login, a few tokens |
