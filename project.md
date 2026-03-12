# PlanMyProject

Plan your project in one Markdown file, expand tasks with Copilot, and execute leaf tasks into real workspace file changes.

## Plan with confidence, implement with control

PlanMyProject turns project planning into an implementation-ready workflow:

- Keep a single plan file in workspace root (`planmyproject.md` or `projectplan.md`)
- Expand any task one level at a time with Copilot (`Alt+P`)
- Track hierarchy in a sidebar tree and an auto-generated execution queue
- Implement a selected task through structured Copilot JSON file writes

## Requirements

1. VS Code `1.95+`
2. Trusted workspace (untrusted workspaces are not supported)
3. GitHub Copilot access for `Plan Task` and `Implement Task`

## Get Started

1. Run `PlanMyProject: Open Plan`
2. Add a root objective with `PlanMyProject: Add Root Task`
3. Place cursor on that task and run `PlanMyProject: Plan Task (One Level)` (or press `Alt+P`)
4. Repeat planning on child tasks as needed
5. Run `PlanMyProject: Implement Task (Copilot)` on a leaf task to apply code changes

## Features (Implemented) with Examples

### 1) Single source-of-truth plan file

Behavior:
- Uses root file in this order: `planmyproject.md`, then `projectplan.md`
- Creates `planmyproject.md` if no plan file exists
- Watches file edits and refreshes tree/decorations live

Example:
```text
Command: PlanMyProject: Open Plan
Result: Creates /workspace/planmyproject.md with schema scaffold when missing
```

### 2) Standard markdown schema + resilient parsing

Behavior:
- Writes schema v1 with `Plan Tree` and `Execution Queue`
- Accepts strict task lines and also looser bullet/numbered markdown when parsing existing files
- Generates stable task IDs (`T0001`, `T0002`, ...)

Example output:
```md
# Project Plan

<!-- pmp:schema=v1 -->

## Plan Tree
- [ ] [T0001] Build user authentication system
  <!-- pmp:id=T0001;parent=ROOT -->

  - [ ] [T0002] Create login API
    <!-- pmp:id=T0002;parent=T0001 -->

## Execution Queue (Auto-Generated, Leaf Tasks Only)
1. [T0002] Create login API
```

### 3) Load requirements from a root `.md` file

Behavior:
- `PlanMyProject: Load Requirements File` imports root tasks from another root markdown file
- Supports append or replace mode when tasks already exist
- Filters obvious non-task headings/metadata

Example:
```text
requirements.md:
- Build authentication module
- Add role-based authorization

Command: PlanMyProject: Load Requirements File
Result: Creates two root tasks with new task IDs
```

### 4) Manual task creation (root and child)

Behavior:
- `PlanMyProject: Add Root Task` always adds a top-level task
- `PlanMyProject: Add Task` adds under selected task (or root if no parent context)

Example:
```text
Select [T0001] Build auth
Run: PlanMyProject: Add Task
Input: "Create login endpoint"
Result: Child task [T0002] is inserted under [T0001]
```

### 5) One-level AI planning (recursive by rerun)

Behavior:
- `Plan Task` expands only immediate children for selected task
- If task already has children, prompts:
  - `Refine existing children`
  - `Replace existing children`
- Streams Copilot output into plan file while generating

Example:
```text
Task: [T0001] Build auth
Run: PlanMyProject: Plan Task (One Level)
Copilot output bullets -> child tasks [T0002..T0005]
Run again on [T0002] for deeper planning
```

### 6) Task execution via Copilot with file writes

Behavior:
- `Implement Task` requests JSON from Copilot and writes files to workspace
- Supports create/update file writes (full-file content per path)
- Rejects unsafe paths (absolute paths, `..`, external URIs)
- Blocks writes that resolve outside workspace root (including symlink-escape ancestors)
- If model output is invalid JSON, sends a repair request (with consent)
- Marks selected task subtree done (`[x]`) after successful apply

Example JSON shape expected from Copilot:
```json
{
  "summary": "Added auth controller and route wiring",
  "taskCompleted": true,
  "changes": [
    { "path": "src/auth/controller.ts", "content": "..." },
    { "path": "src/auth/routes.ts", "content": "..." }
  ],
  "tests": ["npm test"],
  "risks": ["Token rotation not yet implemented"]
}
```

### 7) Execution Queue auto-generated from leaf tasks

Behavior:
- Queue is always rebuilt from current leaf nodes
- Triggered on save and via `PlanMyProject: Rebuild Execution Queue`

Example:
```md
## Execution Queue (Auto-Generated, Leaf Tasks Only)
1. [T0004] Add input validation
2. [T0005] Write integration tests
```

### 8) Tree view, drill-down navigation, and task actions

Behavior:
- Activity bar view: `PlanMyProject` -> `Implementation Tree`
- Click any tree item to drill into task line
- Tree context menu provides Add/Plan/Implement/Drill/Delete for normal items
- Running request progress is shown on the active task item itself
- Running task item exposes only `Cancel Active Request` inline action

Example:
```text
Click tree item [T0005] Write integration tests
Result: editor jumps to that task line in plan file
```

### 9) CodeLens and gutter action hints

Behavior:
- CodeLens on each task line: `Plan | Drill | Implement`
- Gutter icons:
  - Planning icon for non-leaf tasks
  - Execute icon for leaf tasks

Example:
```text
Open plan file -> every task line shows actions without editing markdown links
```

### 10) Status propagation and in-item progress visualization

Behavior:
- Supported statuses: `[ ]`, `[/]`, `[x]`
- Parent status is derived from children:
  - all done -> `[x]`
  - partial done -> `[/]`
  - none done -> `[ ]`
- Tree icons mirror these statuses
- Active Plan/Implement request overlays task icon/state (`loading`, `check`, `error`, `cancelled`)
- Requests can be cancelled from tree inline action or `PlanMyProject: Cancel Active Request`

Example:
```text
Children: [x], [ ]
Parent auto-updates to [/]
```

### 11) Delete task subtree

Behavior:
- `PlanMyProject: Delete Task` removes selected task and all descendants
- Requires modal confirmation

Example:
```text
Delete [T0003]
Result: [T0003] and its nested tasks are removed, queue is regenerated
```

### 12) Privacy controls and consent gates

Behavior:
- Copilot calls are gated by a modal consent dialog
- Session-level `Allow All` option is available
- Sensitive token patterns in prompts are masked (`[REDACTED]`)
- Sensitive target files (`.env*`, `.git/*`, `.github/*`, `.vscode/*`, lockfiles/configs) require extra approval before writes

Example:
```text
Implement suggests change to package.json + .vscode/settings.json
Result: extra "Apply Sensitive Changes" confirmation appears before write
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
- `PlanMyProject: Cancel Active Request`

## Original Spec vs Current Implementation

| Original requirement | Current status | Notes |
| --- | --- | --- |
| Single root `projectplan.md` file | Implemented (extended) | Supports both `planmyproject.md` and `projectplan.md` |
| Schema with Plan Tree + Execution Queue | Implemented | Queue is leaf-task ordered list |
| Contextual AI planning with parent context | Implemented | Sends selected task, ancestors, existing children, relevant file paths |
| Recursive nesting | Implemented | One level per run; recurse by rerunning on child |
| In-place streamed plan writing | Implemented | Children are updated while Copilot response streams |
| Flat leaf queue for execution | Implemented | Auto-generated and rebuild command available |
| Agent hand-off / run action | Implemented (via commands) | Implement action is in CodeLens/Tree, not markdown links |
| Gutter decorations for plan/execute | Implemented | Leaf vs non-leaf icons |
| Activity bar implementation tree | Implemented | Dedicated view container + tree |
| Idempotent plan rerun refine/replace | Implemented | Quick pick shown when children already exist |
| Context-aware expansion | Partially implemented | File-path relevance heuristic; no semantic code analysis |
| Privacy masking before LLM send | Implemented | Token/secret patterns masked, plus explicit consent |

## Known Limits

- Implement flow writes files only; no delete/rename operations.
- Copilot model selection uses first available model from VS Code LM API.
- Requirement import scans root-level markdown files only.
- Queue section is extension-generated and should not be manually maintained.
- Only one active request is tracked/cancellable at a time.

## Feedback

If planning/import/implementation behavior is off, capture:
1. Command used
2. Task ID
3. Copilot consent choice
4. Resulting plan snippet or write target paths

This data is enough to reproduce most issues quickly.

## Privacy

PlanMyProject sends data to Copilot only when you explicitly run Copilot-backed actions and approve consent prompts.

- Prompt masking is applied before send for common secret/token patterns.
- You can approve one request (`Send to Copilot`) or all requests for the current session (`Allow All`).
- Sensitive file writes require an additional confirmation step.

## Troubleshooting

If commands do not work as expected:

1. Ensure a workspace folder is open (not a single loose file).
2. Confirm VS Code version is `1.95+`.
3. Verify Copilot access for planning/implementation commands.
4. Check the plan file is in workspace root and named `planmyproject.md` or `projectplan.md`.
5. Run `PlanMyProject: Refresh Tree` and `PlanMyProject: Rebuild Execution Queue` after manual edits.

## More Resources

- Command palette entries: all `PlanMyProject:*` commands listed above
- Sidebar: Activity Bar -> `PlanMyProject` -> `Implementation Tree`
- Keyboard shortcut: `Alt+P` for `Plan Task (One Level)`

## What's New in This Implementation

- Added requirements import flow with append/replace behavior
- Added explicit Copilot consent and sensitive-write confirmation
- Added repair retry path for invalid implementation JSON
- Added tree view + CodeLens + gutter action surface for plan execution workflow
- Added cancellable active-request flow with per-task tree progress/status
- Added workspace-write hardening against symlink-escape paths
