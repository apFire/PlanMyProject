# PlanMyProject

PlanMyProject is a VS Code extension that manages a single root plan file as the project planning source of truth.

Supported root plan files (in priority order):

- `planmyproject.md`
- `projectplan.md`

## Key Behavior

- One-level planning only: `Plan Task` expands only the selected task by one level.
- Recursive depth is user-driven: run `Plan Task` again on child tasks to go deeper.
- Every task has executable actions via CodeLens and Tree View icons: `Plan`, `Drill`, `Implement`.
- `Execution Queue` is auto-generated from leaf nodes.
- Copilot LM APIs are used for `Plan` and `Implement`.
- `Implement` writes real workspace files from structured Copilot output, then updates task status.
- After a successful `Implement`, the selected task/subtree is marked done (`[x]`) in both Tree View and plan markdown.

## Commands

- `PlanMyProject: Open Plan`
- `PlanMyProject: Plan Task (One Level)` (`Alt+P`)
- `PlanMyProject: Add Task`
- `PlanMyProject: Drill Down Task`
- `PlanMyProject: Implement Task (Copilot)`
- `PlanMyProject: Delete Task`
- `PlanMyProject: Rebuild Execution Queue`

## Notes

- The extension creates `planmyproject.md` in the workspace root when no plan file exists.
- Markdown tasks are kept clean: no embedded command links are written into the plan file.
- Parent task status is derived from child statuses:
  - all done => `[x]`
  - partial done/in-progress => `[/]`
  - otherwise => `[ ]`

## Data Exchange with Copilot

PlanMyProject only sends data to GitHub Copilot when you run Copilot-backed actions (`Plan Task`, `Implement Task`, and repair retries during implement parsing).

- Consent is requested before each send.
- Consent dialog options:
  - `Send to Copilot`: approve this request only.
  - `Allow All`: approve this request and auto-approve future Copilot requests for the current extension session.
  - Close/Cancel: no data is sent.
- For `Plan Task`, the prompt includes:
  - selected task id/title
  - ancestor task titles
  - existing child task titles (when present)
  - relevant workspace file paths
  - no file contents
- For `Implement Task`, the prompt includes:
  - selected task id/title and ancestor task titles
  - relevant workspace file paths
  - file content snapshots from relevant files (text-only, size-limited, may be truncated)
- If implement JSON parsing fails, a repair request may send an excerpt of the prior Copilot output.

## Supported Workspace Edits

When `Implement Task` is approved and Copilot returns valid JSON changes, the extension applies file writes in your workspace.

- Supported:
  - create new files
  - update existing files
  - create missing parent directories for generated files
- Safety and scope:
  - only workspace-relative paths are accepted
  - absolute paths and path traversal (`../`) are rejected
  - if duplicate paths are returned, the last entry wins
- Not supported:
  - file deletion
  - file rename/move operations
- Extra confirmation is required for sensitive targets (for example `.env*`, `.git/*`, `.github/*`, `.vscode/*`, lockfiles, and common config files like `tsconfig*.json`, ESLint, and Prettier configs).
