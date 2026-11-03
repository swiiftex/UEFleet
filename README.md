# UE Fleet

Run many Claude agents on an Unreal project at once. They all work from the project's own files, and each gets its own editor, so nobody waits for Play In Editor and a build doesn't close anyone else's editor.

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

Agents work directly in your project folder, so a new task starts straight away. Each one's editor is started with `-UserDir`, which moves its `Saved` and `Intermediate` folders to a folder of its own in the app's data. Its logs, settings, autosaves and crash reports stay there, and the app adds nothing to your project.

That folder starts with your project's asset registry cache, linked rather than copied, so a first boot doesn't have to read every asset again. On Night Crew that takes two editors from 190 seconds to 50. Once the editor writes its own cache the folder is about 450 MB, and the next task reuses it.

A project's own plugins may still write to its folder whenever an editor starts, as Wwise and RiderLink do on Night Crew. Plastic doesn't count those as changes, but they do appear on the **Changes** tab.

Each editor also gets its own MCP port, PIE port and log through command-line overrides, and your project files aren't edited to do it. Agents reach their editor through their own tools, and `strictMcpConfig` keeps every other MCP server away from them, including anything that could reach your real editor.

Running editors are capped per machine (4 on this PC, editable under Machines). An agent past the cap keeps working on code and only waits when it needs an editor. Idle editors stop after 10 minutes and start again on the next use.

Editor modes: **offscreen** has no window but still renders, **headless** doesn't render at all, and **windowed** is a normal editor you can look at. Audio stays on in every mode so audio features can be tested. The engine outputs silence while unfocused, so instances stay quiet on your speakers.

### Builds

A build uses your project's own `Binaries` and `Intermediate`, so it picks up from your last build instead of compiling everything. Builds of one project run one at a time, and new editors wait for a build to finish before they start.

Editors that are already running stay up. Windows won't let a loaded DLL be overwritten but does let it be renamed, so before each build the app swaps every locked DLL for an unlocked copy. The old file stays beside it as `*.fleet-old-*` until nothing has it loaded, and the next build removes it. Those editors, including your own, keep the code they started with until they restart.

Two things stop a build:

- **Live Coding:** if your own editor has the project open with Live Coding on, Unreal refuses the build, and the agent asks you to close it or turn Live Coding off.
- **A source-built engine:** `ue_build` passes `-NoEngineChanges`, so a build that would change the engine fails instead of relinking engine DLLs under every running editor.

### What sharing costs

There's no wall between agents, so they're told how to behave around each other. These are the risks that remain:

- **Broken code:** one agent's half-finished edit can fail another's build. Agents are told to wait and retry rather than touch it.
- **Same asset:** when two agents save the same asset, the last save wins and the other's work is lost with no warning. Agents can see who else is in the folder and what they're working on, but nothing locks an asset.
- **Your workspace:** everything goes straight into it, alongside your own uncommitted work. Agents are told never to revert, reset, stash, clean, switch or update it, or to check anything in unless you ask, but that's an instruction, not a lock.

## Getting the work back

There's nothing to do on the machine holding the project, because the changes are already there. Check them in with your version control as usual. A card's **Changes** tab lists what changed in the folder since the task started, by any agent or by you, and it can't show deleted files.

For an agent on another machine, the changes stay in that machine's project folder. You can check them in there, or use the card's **Changes** tab and **Apply** to copy them into your project on the master. There's no earlier version to merge against, so a file that also changed on the master since the task started is reported as a conflict.

### Projects sent from the master

A project that was sent to another machine, because that machine had no copy of its own, is the one case that doesn't share. Sending it again would overwrite the folder, and each agent's work has to find its way back, so each agent there gets its own copy. Content and other files that never change in place are hardlinked, so they cost no disk, and source, config and build outputs are real copies. Night Crew measures 94 GB linked and 1.5 GB copied per agent. Run `node scripts/measure-project.mjs <project folder>` to see the numbers for another project.

UE saves an asset by replacing the file, so a save in one copy never reaches another copy or the project. Changes stay in the copy until you press **Apply**. A file that also changed in your project gets a three-way merge if it's text, and is reported as a conflict if it's binary or the merge fails. Merges work on bytes, so line endings and non-UTF-8 characters survive.

Each file has a checkbox. **Apply all finished**, in the tests window, does every finished card at once and reports what it couldn't apply. Archiving a card frees its copy for reuse, and it warns you first if anything hasn't been applied.

Copies of projects that now share are removed once their card is archived, or the next time the app or host starts if they're already free.

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

Agents read and write the real project's Claude memory, so they keep what you've taught them. Their instructions say the instance rules win over notes written for one shared editor, such as anything that reaches an editor on a fixed port.

`Saved/SaveGames` is copied into each agent's own folder, so agents start from your progress instead of a first run. Nothing they do to it comes back.

## Final messages

Agents finish by calling `finish_task` with what they checked themselves and what needs a person. If nothing needs a person, the card just goes to FINISHED with no popup. Otherwise you get a final message and a popup, and the items go on the **tests** list. When everything's done and tests remain, a popup offers the list. An agent that reports it verified nothing still gets a popup, however confident it sounds.

## Linking other machines

Remote machines run `fleet-host.exe`, one file with no UI. The master keeps the cards, chats and decisions. The agents, the project and the editors all run on the remote machine.

1. Run `npm run package` on the master. It writes `release/fleet-host.exe` and `release/UE Fleet-win32-x64/`.
2. Copy `fleet-host.exe` to the other machine. It needs Claude Code signed in there, plus the same Unreal version as the project. A C++ project also needs Visual Studio, because the first build happens there.
3. Open **machines** on the master, copy the pairing code, then run this on the other machine:

```bash
fleet-host.exe --pair <code>
```

It reconnects by itself after that.

The host keeps its machine awake for as long as it runs, and says so when it starts. A laptop also keeps its screen on, because on many laptops the screen going off is what starts standby. Windows treats closing the lid separately, so the host warns you if that would still put it to sleep. To change it, open Control Panel > Power Options > Choose what closing the lid does and pick **Do nothing**.

### Using a copy already on that machine

Before sending a project, the master asks the host for one with the same name, and checks again for every task. The host looks in this order:

1. Anything you pinned with `fleet-host.exe --project "<.uproject or its folder>"`. A running host picks this up by itself, and `--remove-project` undoes it.
2. Unreal's recent projects, including those a source-built engine keeps in its own folder, newest first.
3. Workspaces listed by version control: Plastic, Perforce, GitHub Desktop, Sourcetree, Fork and GitKraken.
4. The usual folders under your user folder: `wkspaces`, `Documents\GitHub`, `Documents\Unreal Projects`, `source\repos`, `Perforce` and `p4`.

Your copy is used as it is and isn't compared with the master's, so keep it up to date. Agents on that machine all work directly in it. If there's more than one, the card says which it used and what else it found.

If nothing is found, the project is sent instead, and a send over 1 GB asks you first. Debug symbols are skipped, and later tasks only send what changed. Stopping the card stops the transfer, and messaging a card that never got its project tries again.

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
node scripts/real-test.mjs shared-project
```

| Test | Covers | Needs |
|---|---|---|
| `npm test` | Sharing, copying, merging, the hub, and a real host process over TLS | Nothing |
| `npm run test:ui` | The real app with real key presses and scripted agents | Nothing |
| `cli-editors` | The real Claude CLI and real editors in one folder, with a scripted API in place of the model | UE 5.8 |
| `builds` | Building a C++ project while another agent's editor has it loaded, and copies compiling at once | UE 5.8, Visual Studio |
| `real-agents` | The real model on the cheapest tier | UE 5.8, a Claude login, a few tokens |
| `shared-project` | Two real editors on a project of yours, then what they changed there. Set `FLEET_PROJECT` to its `.uproject`. It never builds or saves | The project's engine |
