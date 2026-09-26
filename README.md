# Nebula Desktop

A desktop client for [nebula](https://github.com/AgentSystemLabs/nebula). It talks to the same
daemon as the `nebula` TUI, so both can be open at once on the same sessions. Close either one
and your agents keep running.

- **Projects sidebar**: scrollable and filterable (`⌘P`, `⌘1`–`⌘9`). Each project shows a status
  bar with one segment per session.
- **Waiting on you**: every session blocked on a permission prompt or question, across all
  projects. `⌘J` cycles through them. You also get a macOS notification and a dock badge count.
- **Worktree bands**: sessions grouped by branch, with the ones that need you sorted first.
  Each row shows its last prompt.
- **Terminal**: attach to any agent or shell. Shift+Enter inserts a newline in Claude Code.
  Double-click the title to rename a session.
- **New task** (`⌘N`): run on an existing branch or a new worktree (the branch name is suggested
  from the task), choose the agent and a preset. `⌘↵` starts it.

## Running

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

After `nebula upgrade`, bump the tag and rebuild. If the protocol changed, `src/nebula/types.ts`
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
handy for styling, and needs no daemon.

## Layout

- `src-tauri/src/daemon.rs`: the socket connection. It forwards daemon events to the webview,
  with terminal output sent separately as base64.
- `src/nebula/`: typed protocol mirror, store, client (request/Ack routing), notifications.
- `src/components/`: sidebar, sessions column, terminal pane, new-task dialog.
