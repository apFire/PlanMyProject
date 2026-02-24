# PlanMyProject

Plan your project in one Markdown file, expand tasks with Copilot, and execute leaf tasks into real workspace file changes.

## Requirements

1. VS Code `1.95+`
2. Trusted workspace (untrusted workspaces are not supported)
3. GitHub Copilot access for `Plan Task` and `Implement Task`

## Get Started

1. Run `PlanMyProject: Open Plan`
2. Add a root objective with `PlanMyProject: Add Root Task`
3. Select that task and run `PlanMyProject: Plan Task (One Level)` (or `Alt+P`)
4. Repeat planning on child tasks to deepen the plan
5. Run `PlanMyProject: Implement Task (Copilot)` on a leaf task to apply changes

Supported plan files in workspace root (priority order):

- `planmyproject.md`
- `projectplan.md`

## Features and Examples

### 1) Single source-of-truth plan file

- Uses one root plan file and creates `planmyproject.md` if none exists
- Watches plan file changes and keeps UI in sync

Example:

```text
Command: PlanMyProject: Open Plan
Result: /workspace/planmyproject.md is created with initial schema scaffold
```

### 2) Markdown schema with auto-generated execution queue

- Writes schema with:
  - `## Plan Tree`
  - `## Execution Queue (Auto-Generated, Leaf Tasks Only)`
- Queue is derived from current leaf tasks

Example:

```md
# Project Plan

<!-- pmp:schema=v1 -->

## Plan Tree
- [ ] [T0001] Build auth system
  <!-- pmp:id=T0001;parent=ROOT -->

  - [ ] [T0002] Create login API
    <!-- pmp:id=T0002;parent=T0001 -->

## Execution Queue (Auto-Generated, Leaf Tasks Only)
1. [T0002] Create login API
```

### 3) Load root tasks from requirements markdown

- Command: `PlanMyProject: Load Requirements File`
- Imports top-level tasks from a root `.md` file
- Supports `Append` or `Replace` when plan already has tasks

Example:

```text
requirements.md:
- Build authentication module
- Add role-based authorization

Command: PlanMyProject: Load Requirements File
Result: root tasks are added with generated IDs
```

### 4) Manual task creation

- `PlanMyProject: Add Root Task` creates a root task
- `PlanMyProject: Add Task` creates a child task under selected task

Example:

```text
Select [T0001] Build auth
Run: PlanMyProject: Add Task
Input: "Create login endpoint"
Result: child [T0002] appears under [T0001]
```

### 5) One-level AI planning (recursive by rerun)

- `Plan Task` only creates immediate children of the selected task
- If children already exist, you choose:
  - `Refine existing children`
  - `Replace existing children`
- Copilot output is streamed into the plan file

Example:

```text
Task: [T0001] Build auth
Run: PlanMyProject: Plan Task (One Level)
Result: [T0002..T0005] created as direct children
```

### 6) Implement task with Copilot JSON writes

- `Implement Task` asks Copilot for structured JSON changes
- Applies create/update file writes in workspace
- Marks selected task subtree `[x]` on successful apply

Example response format:

```json
{
  "summary": "Added auth routes and controller",
  "taskCompleted": true,
  "changes": [
    { "path": "src/auth/routes.ts", "content": "..." },
    { "path": "src/auth/controller.ts", "content": "..." }
  ],
  "tests": ["npm test"],
  "risks": ["Token refresh flow pending"]
}
```

### 7) Tree view, CodeLens, and drill-down workflow

- Activity Bar container: `PlanMyProject` -> `Implementation Tree`
- Task actions in tree context menu: Add, Plan, Implement, Drill, Delete
- CodeLens on task lines: `Plan | Drill | Implement`
- Click tree item to jump to task line (`Drill Down`)

Example:

```text
Click [T0005] in Implementation Tree
Result: editor jumps to [T0005] in plan file
```

### 8) Status propagation and progress

- Status values: `[ ]`, `[/]`, `[x]`
- Parent status is derived from child states
- Leaf tasks get execute gutter icon; non-leaf tasks get planning icon

Example:

```text
Children: [x], [ ]
Parent becomes [/]
```

### 9) Safe delete and queue rebuild

- `PlanMyProject: Delete Task` removes selected subtree (with confirmation)
- `PlanMyProject: Rebuild Execution Queue` recalculates queue from leaves

Example:

```text
Delete [T0003]
Result: [T0003] and descendants removed, queue updated
```

## Command Reference

- `PlanMyProject: Open Plan`
- `PlanMyProject: Plan Task (One Level)` (`Alt+P`)
- `PlanMyProject: Add Task`
- `PlanMyProject: Add Root Task`
- `PlanMyProject: Load Requirements File`
- `PlanMyProject: Drill Down Task`
- `PlanMyProject: Implement Task (Copilot)`
- `PlanMyProject: Delete Task`
- `PlanMyProject: Rebuild Execution Queue`
- `PlanMyProject: Refresh Tree`

## Privacy and Copilot Data Flow

Copilot requests only happen for Copilot-backed actions and only after consent.

- Per-request approval via `Send to Copilot`
- Session approval via `Allow All`
- Prompt masking redacts common token/secret patterns before send
- Extra confirmation is required for sensitive file targets, including:
  - `.env*`
  - `.git/*`, `.github/*`, `.vscode/*`
  - lockfiles and common config files (`tsconfig*`, ESLint, Prettier, etc.)

## Supported Workspace Edits

When implementation JSON is valid and approved:

- Supported:
  - create files
  - update files
  - create parent directories
- Safety:
  - workspace-relative paths only
  - rejects absolute paths and `..` traversal
  - if duplicate paths are returned, the last one wins
- Not supported:
  - file deletion
  - file rename/move

## Troubleshooting

1. Open a workspace folder (not a single loose file).
2. Ensure VS Code is `1.95+`.
3. Confirm Copilot is available for planning/implementation commands.
4. Keep plan file in root as `planmyproject.md` or `projectplan.md`.
5. Use `PlanMyProject: Refresh Tree` and `PlanMyProject: Rebuild Execution Queue` after heavy manual edits.
