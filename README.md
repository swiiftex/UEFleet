# UE Fleet

Run many Claude agents on an Unreal project at once. A master chat places each request on the best PC and fetches what the agents can't reach. They all work from the project's own files, and each gets its own editor, so nobody waits for Play In Editor and a build doesn't close anyone else's editor.

Every task moves through the same stages, and pauses whenever it needs you:

**Preparing → Building → Testing → Awaiting merge → Merged → Checking in → Complete**

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
| `Ctrl+N` | New task, which goes to the master chat. If what you type matches a card, `Alt+1`…`3` sends it there instead |
| `Ctrl+0` | Open the master chat |
| `Ctrl+1`…`9` | Jump to a card |
| `Enter` / `Ctrl+Enter` | Send / new line in the message box |

## The master chat

Everything you type with `Ctrl+N` goes to the master chat, one long Claude session on this PC with your own logins. It checks whether the request belongs with an agent that's already on it. If not, it fetches any ticket or document the request mentions and starts an agent with all of that in its brief. You can also talk to it directly from its bar above the cards.

It can't edit files, and it doesn't do the task itself. If it can't run, your request starts anyway, on its own, so nothing gets lost.

**Placement** is automatic unless you pick a machine. A task goes to another PC when one is free, meaning CPU under 60% and at least 12 GB of RAM free, with room for another editor and a copy of the project. Otherwise it stays on this PC. If this PC is out of room too, it goes to the least busy machine, even if that means sending the project. The card says why it ended up where it did.

**Agents asking back:** this PC may be the only one logged into Jira, Codevelop and the like. Any agent, on any machine, can call `ask_master`, and it waits while the master looks the answer up, asking you first if only you know. If the app restarts in the meantime, the question gets asked again.

## How an instance works

Agents work directly in your project folder, so a new task starts straight away. Each one's editor is started with `-UserDir`, which moves its `Saved` and `Intermediate` folders to a folder of its own in the app's data. Its logs, settings, autosaves and crash reports stay there, and the app adds nothing to your project.

That folder starts with your project's asset registry cache, linked rather than copied, so a first boot doesn't have to read every asset again. On Night Crew that takes two editors from 190 seconds to 50. Once the editor writes its own cache the folder is about 450 MB, and the next task reuses it.

A project's own plugins may still write to its folder whenever an editor starts, as Wwise and RiderLink do on Night Crew. Plastic doesn't count those as changes, but they do appear on the **Files** tab.

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

## A task's stages

The panel at the top of each task always shows which stage it's at, where its files are and what you need to do. A stage turns orange when it's waiting on you.

| Stage | What's happening |
|---|---|
| **Preparing** | Getting set up and reading |
| **Building** | The agent is making the change and compiling |
| **Testing** | The agent tests its own work, then hands you a checklist if anything needs a person. An agent that proved its change works skips your part |
| **Awaiting merge** | Bringing its files into your workspace. Pauses if a file also changed there |
| **Merged** | Its files are in your workspace |
| **Checking in** | The master chat puts them in a named Plastic changelist |
| **Complete** | Done. You check the changelist in from Plastic when you're ready |

**Checking in never checks anything in.** It only sorts the files into a changelist. Plastic only accepts checked-out and added files in a changelist, so plain edits get checked out and new files added first, which also takes any lock your team uses. A file someone else has locked is reported on the card.

A project that isn't in Plastic goes straight from Merged to Complete.

### Testing

When a task needs you, you get a checklist with exact steps and what you should see for each, written by the agent. **To test** in the top bar jumps to the next one.

- **Open editor** brings the agent's files into your workspace, compiles if any code changed, and opens a normal editor window with your own settings, so you can change things in it. It stays open if the app restarts. If you already have that project open, close it first, because an open editor keeps the code it started with.
- **Approve (tested)** moves the task on to merging.
- **Issue found** asks what's wrong and sends that straight back to the agent, which fixes it and hands you a new checklist.

### Where the files are

An agent on the machine holding your workspace works directly in it, so merging is only a matter of noting which files are its own. An agent on another machine works in that machine's project folder, and merging copies its files over the link into your workspace. A file that also changed in your workspace since the task started pauses for you to pick **Use the agent's version** or **Keep mine**.

Each agent keeps track of which files are its own: what its tools edited, what its editor saved, and what it says it changed when it finishes. A change made some other way that it doesn't report won't be merged or go in the changelist. The **Files** tab shows that list, and can also scan for everything that changed in the folder. On Night Crew that scan takes about half a minute, and it can't show deleted files.

### Projects sent from the master

A project that was sent to another machine, because that machine had no copy of its own, is the one case that doesn't share. Sending it again would overwrite the folder, and each agent's work has to find its way back, so each agent there gets its own copy. Content and other files that never change in place are hardlinked, so they cost no disk, and source, config and build outputs are real copies. Night Crew measures 94 GB linked and 1.5 GB copied per agent. Run `node scripts/measure-project.mjs <project folder>` to see the numbers for another project.

UE saves an asset by replacing the file, so a save in one copy never reaches another copy or the project. When one merges, a file that also changed in your project gets a three-way merge if it's text, and pauses for you if it's binary or the merge fails. Merges work on bytes, so line endings and non-UTF-8 characters survive.

Archiving a card frees its copy for reuse, and it warns you first if anything hasn't been merged. Copies of projects that now share are removed once their card is archived, or the next time the app or host starts if they're already free.

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
| `neverApply` | Files that are never merged or put in a changelist |
| `agentNotes` | Added to every agent's instructions |
| `mcpServers` | Extra MCP servers for agents. Nothing else gets through, so a server that reaches your real editor would defeat the isolation |

## Project notes and saves

Agents read and write the real project's Claude memory, so they keep what you've taught them. Their instructions say the instance rules win over notes written for one shared editor, such as anything that reaches an editor on a fixed port.

`Saved/SaveGames` is copied into each agent's own folder, so agents start from your progress instead of a first run. Nothing they do to it comes back.

## Final messages

Agents finish by calling `finish_task` with what they checked themselves, what needs a person, and which files they changed. If nothing needs a person, the task carries on to Complete with no popup. Otherwise you get a popup and a checklist. When everything's done and tests remain, a popup takes you to them. An agent that reports it verified nothing still gets a popup, however confident it sounds.

## Progress

Each card has a bar showing roughly how far through its task the agent is. It's the agent's own estimate, reported with `report_progress` at each real step forward, so it can go backwards if a job turns out bigger. Only finishing fills it to 100%, and a card shows `–` until its agent first reports. A follow-up message to a finished card starts the bar again.

## The chat

**Messages only**, beside the chat's tabs, hides tool calls, thinking, screenshots and status notes on every card, and it's remembered between runs. A prompt waiting on you and an error that stopped the agent still show, because without them a stuck agent would look like it was just quiet.

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

The host dials out to the master, so only the master listens on a port (47800). The connection is TLS, and the host pins the master's certificate from the pairing code. Anyone with a pairing code can link a machine to your master, so treat it like a password. **New code** replaces it. A linked master can run agents on a host and replace its exe, so only link machines to a master you trust.

### VMs

A VM is just another machine: install Windows, Unreal and Claude Code in it, run `fleet-host.exe`, and it joins like the laptop. Process instances on the same PC use far less memory for the same parallel PIE, so use a VM when you need the separation itself.

## Working on UE Fleet itself

You can change UE Fleet while it's running real tasks. This publishes the current code to the running app, with nothing to close:

```bash
npm run deploy
```

`npm run deploy:watch` keeps doing it whenever a file under `src` changes. Each part then updates as gently as it can:

| What changed | What happens | What it interrupts |
|---|---|---|
| The screens | They reload by themselves, or a button appears if you're typing | Nothing |
| The app's logic | A **New version: restart** button appears, and the app is back in a few seconds | Only the master chat's current turn, and it picks that up again. Agents and editors keep running, on this PC and others |
| The host | Every machine, this PC included, is sent the new host and restarts into it once no agent there is busy | Editors on that machine, which start again on next use. A busy machine waits |

If a busy machine can't wait, **Restart now** under **machines** restarts it anyway, and its agents carry on from their conversation afterwards, though a tool call in progress is lost. The test editor isn't tied to any of this, so it stays open throughout.

This works because the app holds no agents or editors itself. This PC runs its own `fleet-host.exe` in the background, linked to the app the same way any other machine is, and the app loads from versioned folders under `app` in its data folder. Closing the app normally still stops this PC's agents and editors, as you'd expect.

A new machine still needs `fleet-host.exe` copied to it once and paired, and so does a host from before this feature. Replacing Electron itself, the program that runs the app, also needs a full `npm run package`, and so does changing what the loader does. If you run that with the app open, it writes to `release/next` instead.

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
| `npm test` | Stages, placement, changelists, sharing, copying, merging, the hub, and a real host process over TLS | Nothing |
| `npm run test:ui` | The real app with real key presses and scripted agents, off screen | Nothing |
| `node test/packaged.e2e.mjs` | The packaged app: hosts updating themselves, and new versions reaching the app while an agent keeps running | `npm run package` first |
| `cli-editors` | The real Claude CLI and real editors in one folder, with a scripted API in place of the model | UE 5.8 |
| `builds` | Building a C++ project while another agent's editor has it loaded, and copies compiling at once | UE 5.8, Visual Studio |
| `real-agents` | The real model on the cheapest tier | UE 5.8, a Claude login, a few tokens |
| `shared-project` | Two real editors on a project of yours, then what they changed there. Set `FLEET_PROJECT` to its `.uproject`. It never builds or saves | The project's engine |
