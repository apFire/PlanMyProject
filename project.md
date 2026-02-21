
Create PlanMyProject, a vscode extension that unifies all plans related to project into one projectplan.md file. This files lists down high level objectives. each objective can be expanded using plan mode using existing vscode ai subscription. output of this plan command will be written in same file. similarly each sub steps can be expanded and planned further. the file should have a ordered list of all tasks which can be implemented  using ai agents in vscode.

1. Functional Requirements
Core File Management

    The Single Source of Truth: The extension must monitor and manage a specific projectplan.md file in the workspace root.

    Standardized Schema: Uses a specific Markdown flavor (e.g., nested Task Lists) that the extension can parse reliably.

AI Integration ("Plan Mode")

    Contextual Expansion: When a user triggers "Plan Mode" on a specific line, the extension sends that task plus its parent context to the VS Code AI (GitHub Copilot/Language Model API).

    Recursive Nesting: The system must support infinite nesting.

    High-Level Objective

        Sub-task A (Expanded via AI)

            Implementation Detail (Expanded via AI)

    In-Place Writing: AI output must be streamed directly into the projectplan.md file under the active line, properly indented.

Agent-Ready Task List

    Ordered Execution: The extension must maintain a "Flat View" or a specific section at the bottom of the file that lists all "leaf nodes" (tasks with no further sub-steps) in an executable order.

    Agent Hand-off: Each task should have a unique ID or a "Run" button that triggers an AI Agent (like Copilot Labs or a custom agent) to attempt implementation.

2. Technical Architecture
Component	Responsibility
Markdown Parser	Reads the .md file and converts it into a Tree Data Structure.
VS Code LM API	Interfaces with the user’s existing AI subscription to generate plans.
File Watcher	Updates the UI and "Task List" in real-time as the file is edited manually or by AI.
Command Palette	Provides commands like Unified Plan: Expand Objective or Unified Plan: Finalize Task List.
3. User Interface (UI) Requirements

    Gutter Decorations: Add icons in the VS Code gutter (next to line numbers) to "Expand" or "Execute" a task.

    Progress Tracking: Visual indicators (e.g., [ ], [/], [x]) that sync between the Markdown file and the VS Code Activity Bar.

    Plan Mode Toggle: A dedicated view in the Side Bar to see the "Implementation Tree" without the clutter of the full Markdown file.

4. Non-Functional Requirements

    Idempotency: Re-running "Plan Mode" on an existing task should offer to refine or replace the existing sub-steps, not just append duplicates.

    Context Awareness: The expansion must be aware of the existing codebase. If a sub-step is "Create a login API," the AI should check if auth.ts already exists.

    Privacy: Ensure no sensitive keys within the projectplan.md are sent to the LLM without masking.

5. Sample Workflow (Logic)

    User writes: 1. Build user authentication system

    Action: User hits Alt + P (Plan Mode).

    Extension Logic: * Prompt: "Break down 'Build user authentication system' into 3-5 technical sub-tasks for a Node.js environment."

        Output is inserted as 1.1, 1.2, etc.

    User writes: 1.1.1. Write Jest test for login.

    Agent Trigger: Extension detects a "leaf node" and adds it to the Global Implementation Queue.

6. Markdown Schema v1 (Standardized Format)

Use a strict, extension-owned schema with two sections:

    Plan Tree: Source of truth for tasks and hierarchy.

    Execution Queue: Auto-generated ordered list of leaf tasks.

Reference template:

```md
# Project Plan

<!-- pmp:schema=v1 -->

## Plan Tree
- [ ] [T0001] Build user authentication system
  <!-- pmp:id=T0001;parent=ROOT -->
  [Plan](command:planmyproject.planTask?%5B%22T0001%22%5D) | [Drill](command:planmyproject.drillDown?%5B%22T0001%22%5D) | [Implement](command:planmyproject.implementTask?%5B%22T0001%22%5D)

  - [ ] [T0002] Create login API
    <!-- pmp:id=T0002;parent=T0001 -->
    [Plan](command:planmyproject.planTask?%5B%22T0002%22%5D) | [Drill](command:planmyproject.drillDown?%5B%22T0002%22%5D) | [Implement](command:planmyproject.implementTask?%5B%22T0002%22%5D)

  - [/] [T0003] Add auth tests
    <!-- pmp:id=T0003;parent=T0001 -->
    [Plan](command:planmyproject.planTask?%5B%22T0003%22%5D) | [Drill](command:planmyproject.drillDown?%5B%22T0003%22%5D) | [Implement](command:planmyproject.implementTask?%5B%22T0003%22%5D)

## Execution Queue (Auto-Generated, Leaf Tasks Only)
1. [T0002] Create login API
2. [T0003] Add auth tests
```

Schema rules:

    One task per line using: - [status] [TaskID] Title

    Allowed status values: [ ], [/], [x]

    Task IDs are stable and never reused.

    Plan action expands only one level for the selected task.

    Deeper levels are only expanded when user explicitly runs Plan again on a child task.

    Each task must expose executable actions: Plan, Drill, Implement.

    Execution Queue is extension-generated and should not be edited manually.
