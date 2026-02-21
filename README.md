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
