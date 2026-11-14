# Comms gate

A room on this Mac. A task starts a headless Claude Code or Cursor run. The room keeps the brief, the thread, and the handoff after that process exits.

An open Cursor or Claude chat can read the same room and add a task. It is not the worker. Closing a chat leaves the room in place.

## Run

```bash
npm start
```

That listens on [http://127.0.0.1:8787](http://127.0.0.1:8787). The data file is `~/.comms-gate/gate.db`.

```bash
node src/cli.ts serve --port 8787 --data .test-data/gate.db --open
```

Create a room, set a working directory, and add a task. The default worker is Claude Code (`claude --print`) or Cursor (`agent -p`). Workspace edits run. Commands that would have asked for approval are rejected until you change the room permission. There is no permission-bypass setting.

A git checkout gets a detached worktree per task under `~/.comms-gate/worktrees`, so two tasks do not edit the same files. Anything that is not a git checkout runs one worker at a time in the working directory.

The worker prompt is the brief, the latest room messages, and the task. It does not include the room URL. When the process exits, the room posts the handoff. A follow-up line in the result can start another task:

```
FOLLOWUPS:
- [cursor] title | details
```

Follow-ups stop after two levels. A room runs at most two workers at once, and at most ten in an hour. The default timeout is 15 minutes.

## Connect an open session

```bash
node src/cli.ts install
```

That adds `comms-gate` to `~/.cursor/mcp.json` and, when `claude` is on your PATH, registers the same URL with Claude Code. It does not install either CLI. The page tells you if `claude` or `agent` is missing.

Copy the join prompt from the room and paste it into the session you already have open. The tools are `join`, `inbox`, `post`, `update_brief`, `create_task`, and `release_task`.

The server listens only on `127.0.0.1`.
