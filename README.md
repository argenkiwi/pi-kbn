# pi-kbn

Kanban discipline for the [Pi coding agent](https://pi.dev). The agent breaks your request into atomic tasks, moves them **todo → doing → done** one at a time, and stops for your go-ahead after each task.

## What you see

- **Footer status:** `☐ 3 todo  ▶ #4 Add CSV parser  ✓ 5 done` (or `⏸ awaiting confirmation` / `⚠ … (interrupted)`).
- **Widget above the prompt:** the task currently in progress.
- **Ghost hint in the empty prompt box** (press **Tab** to accept, then Enter):
  - `Proceed with next task`: there are todo tasks and nothing is in progress.
  - `Resume current task`: a task was left in progress after Esc, an error, or resuming the session.
- **`/kanban`:** a three-column board overlay.

## What the agent must do

| Rule | Enforcement |
|---|---|
| Plan tasks with `kanban add` before changing files | `edit`/`write` blocked while no task is in progress |
| One task at a time | `kanban start` rejected while another task is doing |
| Stop after `kanban done` | `kanban start`, `edit`, `write` blocked until you send any message |

Read-only tools and `bash` are never blocked, so the agent can still explore.

## Commands

`/kanban` (or `/kanban show`), `/kanban off`, `/kanban on`, `/kanban clear`.

## Install

```bash
cd /path/to/pi-kbn && npm install          # dev deps for tests/types only
ln -s /path/to/pi-kbn ~/.pi/agent/extensions/pi-kbn
# or try it once: pi -e /path/to/pi-kbn/index.ts
```

## Develop

```bash
npm test          # node --test (board model + hook wiring)
npm run typecheck
```

## Notes

- Board state lives in the `kanban` tool results (`details`) and `kanban-state` session entries. It is rebuilt from the current branch, so `/tree`, forks and resumed sessions show the board as it was at that point.
- The ghost hint comes from a `CustomEditor` subclass. If another extension has already replaced the editor, pi-kbn leaves it alone and shows the hint as a widget below the prompt instead.

## License

[MIT](LICENSE)
