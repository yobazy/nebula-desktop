<p align="center">
  <img src="src-tauri/icons/128x128@2x.png" width="128" height="128" alt="Nebula Desktop icon">
</p>

<h1 align="center">Nebula Desktop</h1>

<p align="center">
  A macOS desktop client for <a href="https://github.com/AgentSystemLabs/nebula">nebula</a>, the
  daemon that runs your coding agents across a project's git worktrees.
</p>

<p align="center">
  <img src="docs/demo.gif" width="880" alt="Demo: opening a task that's waiting on you, switching projects, shipping a branch with one click, starting the dev server, the right-click task menu, Claude usage, and switching color themes">
</p>

It talks to the same daemon as the `nebula` TUI, so both can be open at once on the same sessions.
Close either one and your agents keep running.

## Install

**[Download Nebula Desktop](https://github.com/yobazy/nebula-desktop/releases/latest/download/Nebula-Desktop.dmg)**
(macOS, Apple Silicon and Intel), open it, and drag the app into Applications.

The first time you open it, it installs [nebula](https://github.com/AgentSystemLabs/nebula) for you,
at the exact version the app is built for, and starts it. You'll also want an agent CLI for nebula
to run, such as [Claude Code](https://code.claude.com/docs/en/setup).

> The app isn't notarized by Apple yet, so macOS blocks its first launch. Open **System Settings →
> Privacy & Security**, find "Nebula Desktop was blocked", and click **Open Anyway**. You only do
> this once.

### Or build it yourself

One command installs the build tools it needs, nebula, and the app:

```sh
curl -fsSL https://raw.githubusercontent.com/yobazy/nebula-desktop/main/scripts/setup.sh | bash
```

Or from a clone: `./scripts/setup.sh`. It checks for Xcode's command line tools, Node 20+ and
Rust (offering to install what's missing), installs nebula at the pinned version (asking before it
replaces a different one), builds the app into `/Applications`, and opens it. `--check` shows what
it would do without changing anything, and `--help` lists the other options.

## What it does

**Sessions**

![Sessions: projects on the left, each worktree's tasks with its git state in the middle, the selected agent's terminal on the right](docs/screenshots/sessions.jpg)

- **Projects sidebar**: filter it with `⌘P` and jump with `⌘1`–`⌘9`. Each project shows one bar
  segment per session, a spinner with the number of tasks in progress, and badges for tasks waiting
  on you and finished ones you haven't read. `⌘O` adds a project from a folder, with the TUI's
  checks (already a project, missing folder, not a git repo).
- **Waiting on you**: every session blocked on a permission prompt or a question, across all
  projects. `⌘J` cycles through them, and you get a macOS notification and a dock badge.
- **Worktree bands**: sessions grouped by branch, with the ones that need you first. Switching
  projects brings back the session you last had open there.
- **Terminal**: attach to any agent or shell. Shift+Enter inserts a newline in Claude Code.
- **Right-click a task** for the TUI's menu: follow-up prompt, restart, duplicate, rename,
  archive, run or stop the dev server, open the worktree, delete.
- **Hide either column** with `⌘B` (projects) and `⌥⌘B` (tasks), or drag them to resize.
- **New task** (`⌘N`): on an existing branch or a new worktree (the branch name is suggested from
  the task), with your choice of agent and preset.

**Git and shipping**

- Each band shows where its branch stands: files changed with lines added and removed, commits to
  push, a branch that was never pushed, commits behind, merge conflicts, and a remote branch that's
  been deleted.
- **Commit & push**, **Push** or **Resolve** hands the job to an idle agent on that branch, or
  starts one. It waits while an agent there is still mid-turn, so nothing gets committed half-done.

**Running the project**

- **Start** runs the project's run command (the Project setting, or `run` in `.nebula.json`) in the
  worktree's run terminal. Once the dev server prints its address, the band shows it as a link.
- No run command yet? Type one, or ask an agent to work it out and write `.nebula.json`.

**Claude usage** (`⌘U`)

![Claude usage: spend in the current 5-hour window, today and this week, by project, per day, and the heaviest tasks](docs/screenshots/usage.jpg)

Read from Claude Code's own logs on your Mac and priced at API rates: the current 5-hour window,
today, 7 or 30 days, by project and by task, and day by day. Click a task to open it. Your plan's
limits aren't recorded locally, so this shows what you spent, not a percentage of your cap.

**Settings** (`⌘,`)

![Settings in light mode with the Forest theme](docs/screenshots/settings.jpg)

Every tab of the TUI's settings, written to the same files the same way, so a change in either
app shows up in the other. Rows that only affect the TUI's look are tagged. The color theme is
shared with the TUI; System, Dark, Black and Light are for the desktop app, and the terminal
follows them.

**And** a pixel cat that plays at the bottom of the sidebar. It chases a
yarn ball, naps, and sits up when an agent starts waiting on you. Click it to say hi, or turn it
off in Settings.

## Building from source

```sh
npm install
npm run tauri dev      # against your real nebula daemon
npm run tauri build    # .app in src-tauri/target/release/bundle/macos
```

The app connects to the daemon the TUI uses (`nebula` starts it; the app offers to as well).

## Version pinning

The daemon only accepts clients built with its exact `PROTOCOL_VERSION`. `nebula-core` is pinned
by tag in `src-tauri/Cargo.toml`:

```toml
nebula-core = { git = "https://github.com/AgentSystemLabs/nebula", tag = "v0.40.2" }
```

After `nebula upgrade`, bump the tag and rebuild (`./scripts/setup.sh` picks up the new tag and
checks your nebula matches it). If the protocol changed, `src/nebula/types.ts`
may need the same change; the e2e check below catches drift. On a mismatch the app shows a
"doesn't match" screen rather than misbehaving.

## Developing without touching your sessions

`scripts/sandbox.sh` runs a throwaway daemon with its own socket, database and settings, two demo
repos, and a fake agent CLI (`scripts/fake-agent.sh`) that fires nebula's status hooks instead of
calling a model. In a fake agent, type `ask …` to make it wait on you.

```sh
scripts/sandbox.sh app    # the app against the sandbox
scripts/sandbox.sh e2e    # protocol check: worktree, agent, attach, input, statuses
scripts/sandbox.sh stop
```

`npm run dev` on its own serves a browser preview with demo data and a canned terminal. It's
handy for styling, and needs no daemon. The screenshots and the demo above are from it.

## Layout

- `src-tauri/src/daemon.rs`: the socket connection. It forwards daemon events to the webview,
  with terminal output sent separately as base64.
- `src-tauri/src/git.rs`: a checkout's git state (the daemon doesn't report it).
- `src-tauri/src/usage.rs`: reads Claude Code's session logs incrementally into hourly buckets.
- `src-tauri/src/settings.rs`: writes nebula's settings the way the TUI does.
- `src/nebula/`: typed protocol mirror, store, client (request/Ack routing), notifications, and
  the git, usage, runs, settings and theme logic.
- `src/components/`: sidebar, sessions column, terminal pane, dialogs, usage and settings views,
  and the cat (`petBrain.ts` is its behavior, separate from the drawing).
- `src-tauri/icons/app-icon.svg`: the icon's source. Regenerate the set with
  `npx tauri icon src-tauri/icons/app-icon.svg`.
- `scripts/dmg-background.py`: draws the DMG window's background; the layout is under
  `bundle.macOS.dmg` in `src-tauri/tauri.conf.json`.

## Releasing

```sh
npm run tauri build -- --target universal-apple-darwin --bundles dmg
cp "src-tauri/target/universal-apple-darwin/release/bundle/dmg/Nebula Desktop_X.Y.Z_universal.dmg" Nebula-Desktop.dmg
gh release create vX.Y.Z Nebula-Desktop.dmg --generate-notes
```

The asset must be named `Nebula-Desktop.dmg`: the README's download link points at it.
