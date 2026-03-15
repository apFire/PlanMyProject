import * as path from "path";
import * as vscode from "vscode";
import type { ImplementationPayload } from "./implement";
import {
  type ParsedPlan,
  TaskNode,
  collectAncestorChain,
  createTaskIdGenerator,
  findTaskById,
  findTaskByLine,
  listLeafTasks,
  makeTaskNode,
  parseAiTaskTitles,
  parsePlanMarkdown,
  serializePlanMarkdown,
  walkTasks
} from "./model";
import {
  PLAN_FILENAMES,
  ROOT_PLAN_GLOB,
  TaskCommandRef,
  ensurePlanDocument,
  extractTaskCommandRef,
  findExistingPlanDocument,
  getWorkspaceRootUri,
  isPlanDocument,
  resolvePlanDocumentForCommand
} from "./planFile";
import {
  buildImplementPrompt,
  buildImplementRepairPrompt,
  buildPlanPrompt
} from "./prompts";
import {
  buildConsolidatedRequirementTitle,
  extractRootTaskCandidates,
  hasExplicitRequirementList,
  hasImportableMarkdownRequirements
} from "./requirements";
import { PlanTreeProvider } from "./tree";
import {
  collectRelevantFileSnapshots,
  collectRelevantFiles,
  resolveWorkspaceWriteTargetUri
} from "./workspace";
const MAX_IMPLEMENTATION_SNAPSHOTS = 8;
const MAX_IMPLEMENTATION_FILE_CHARS = 14_000;
const MAX_IMPLEMENTATION_TOTAL_CHARS = 52_000;
const MAX_REPAIR_INPUT_CHARS = 32_000;
const COPILOT_PATH_PREVIEW_LIMIT = 8;
const SENSITIVE_FILE_PREVIEW_LIMIT = 8;
const BOOTSTRAP_TASK_TITLE = "Add your first objective";
const TREE_EMPTY_CONTEXT_KEY = "planmyproject.treeEmpty";
const WORKSPACE_OPEN_CONTEXT_KEY = "planmyproject.workspaceOpen";
const COPILOT_ALLOW_ALL_LABEL = "Allow All";
const REQUIREMENT_FILE_HINTS = [
  "project.md",
  "requirements.md",
  "requirement.md",
  "prd.md",
  "spec.md",
  "specification.md",
  "readme.md"
] as const;
const TREE_REQUEST_SUCCESS_CLEAR_MS = 2_500;
const TREE_REQUEST_CANCELLED_CLEAR_MS = 3_000;
const TREE_REQUEST_ERROR_CLEAR_MS = 6_000;

let treeProvider: PlanTreeProvider;
let planDecorationType: vscode.TextEditorDecorationType;
let executeDecorationType: vscode.TextEditorDecorationType;
let internalWriteDepth = 0;
let activePlanUri: vscode.Uri | undefined;
let copilotConsentAllowAll = false;
let activeRequestCancellation: vscode.CancellationTokenSource | undefined;
let implementModuleLoader: Promise<typeof import("./implement")> | undefined;
let lmModuleLoader: Promise<typeof import("./lm")> | undefined;
const parsedPlanCache = new Map<string, { version: number; parsed: ParsedPlan }>();

interface TreeRequestContext {
  token: vscode.CancellationToken;
  report: (detail: string) => void;
  complete: (detail: string) => void;
  cancel: (detail: string) => void;
}

async function loadImplementModule(): Promise<typeof import("./implement")> {
  if (!implementModuleLoader) {
    implementModuleLoader = import("./implement");
  }
  return implementModuleLoader;
}

async function loadLmModule(): Promise<typeof import("./lm")> {
  if (!lmModuleLoader) {
    lmModuleLoader = import("./lm");
  }
  return lmModuleLoader;
}

function getCachedParsedPlan(document: vscode.TextDocument): ParsedPlan {
  const cacheKey = document.uri.toString();
  const cached = parsedPlanCache.get(cacheKey);
  if (cached && cached.version === document.version) {
    return cached.parsed;
  }

  const parsed = parsePlanMarkdown(document.getText());
  parsedPlanCache.set(cacheKey, { version: document.version, parsed });
  return parsed;
}

function clearCachedParsedPlan(uri?: vscode.Uri): void {
  if (!uri) {
    parsedPlanCache.clear();
    return;
  }
  parsedPlanCache.delete(uri.toString());
}

async function loadPlanCommandContext(arg?: unknown): Promise<{
  taskRef: TaskCommandRef;
  doc: vscode.TextDocument;
  parsed: ParsedPlan;
}> {
  const taskRef = extractTaskCommandRef(arg);
  const doc = await resolvePlanDocumentForCommand(taskRef, activePlanUri);
  return { taskRef, doc, parsed: parsePlanMarkdown(doc.getText()) };
}

function resolveTaskTarget(
  parsed: ParsedPlan,
  taskRef: TaskCommandRef,
  editor?: vscode.TextEditor
): TaskNode | undefined {
  if (taskRef.taskId) {
    return findTaskById(parsed.tasks, taskRef.taskId);
  }
  if (editor && isPlanDocument(editor.document)) {
    return findTaskByLine(parsed.tasks, editor.selection.active.line);
  }
  return undefined;
}

function getActivePlanEditor(): vscode.TextEditor | undefined {
  const editor = vscode.window.activeTextEditor;
  return editor && isPlanDocument(editor.document) ? editor : undefined;
}

async function refreshPlanUri(uri: vscode.Uri): Promise<void> {
  await refreshFromDocument(await vscode.workspace.openTextDocument(uri));
}

async function writeAndRefreshPlan(uri: vscode.Uri, text: string): Promise<vscode.TextDocument> {
  const latest = await writePlanContent(uri, text);
  await refreshFromDocument(latest);
  return latest;
}

export function activate(context: vscode.ExtensionContext): void {
  treeProvider = new PlanTreeProvider();
  context.subscriptions.push(treeProvider);
  context.subscriptions.push(vscode.window.registerTreeDataProvider("planmyproject.tree", treeProvider));
  updateWorkspaceContext();
  void vscode.commands.executeCommand("setContext", TREE_EMPTY_CONTEXT_KEY, true);
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      [{ scheme: "file", pattern: ROOT_PLAN_GLOB }],
      new PlanCodeLensProvider()
    )
  );

  planDecorationType = vscode.window.createTextEditorDecorationType({
    gutterIconPath: vscode.Uri.file(path.join(context.extensionPath, "media", "plan.svg")),
    gutterIconSize: "16px"
  });
  executeDecorationType = vscode.window.createTextEditorDecorationType({
    gutterIconPath: vscode.Uri.file(path.join(context.extensionPath, "media", "execute.svg")),
    gutterIconSize: "16px"
  });
  context.subscriptions.push(planDecorationType, executeDecorationType);

  const registerWorkspaceCommand = (
    command: string,
    handler: (arg?: unknown) => Promise<void>
  ): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(command, async (arg?: unknown) => {
        if (!ensureWorkspaceFolderOpen()) {
          return;
        }
        await handler(arg);
      })
    );
  };

  registerWorkspaceCommand("planmyproject.openPlan", async () => {
    const doc = await ensurePlanDocument();
    await vscode.window.showTextDocument(doc, { preview: false });
    await refreshFromDocument(doc);
  });
  registerWorkspaceCommand("planmyproject.planTask", handlePlanTask);
  registerWorkspaceCommand("planmyproject.addTask", handleAddTask);
  registerWorkspaceCommand("planmyproject.addRootTask", async () => {
    await handleAddTask(undefined, true);
  });
  registerWorkspaceCommand("planmyproject.loadRequirementsFile", handleLoadRequirementsFile);
  registerWorkspaceCommand("planmyproject.drillDown", handleDrillDown);
  registerWorkspaceCommand("planmyproject.implementTask", handleImplementTask);
  registerWorkspaceCommand("planmyproject.deleteTask", handleDeleteTask);
  registerWorkspaceCommand("planmyproject.rebuildQueue", async () => {
    const doc = await resolvePlanDocumentForCommand(undefined, activePlanUri);
    await syncExecutionQueue(doc);
    await refreshPlanUri(doc.uri);
  });
  registerWorkspaceCommand("planmyproject.refreshTree", async () => {
    const doc = await findExistingPlanDocument();
    if (doc) {
      await refreshFromDocument(doc);
    }
  });
  context.subscriptions.push(
    vscode.commands.registerCommand("planmyproject.cancelActiveRequest", () => {
      if (!activeRequestCancellation) {
        return;
      }
      activeRequestCancellation.cancel();
    })
  );

  const watcher = vscode.workspace.createFileSystemWatcher(ROOT_PLAN_GLOB);
  context.subscriptions.push(
    watcher,
    watcher.onDidCreate(refreshPlanUri),
    watcher.onDidChange(refreshPlanUri),
    watcher.onDidDelete(async (uri) => {
      clearCachedParsedPlan(uri);
      const doc = await findExistingPlanDocument();
      if (doc) {
        await refreshFromDocument(doc);
        return;
      }
      activePlanUri = undefined;
      setTreeTasks([]);
      updateVisiblePlanDecorations();
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
      updateWorkspaceContext();
      if (!hasOpenWorkspaceFolder()) {
        activePlanUri = undefined;
        setTreeTasks([]);
        updateVisiblePlanDecorations();
        return;
      }

      const existing = await findExistingPlanDocument();
      if (existing) {
        await refreshFromDocument(existing);
        return;
      }
      activePlanUri = undefined;
      setTreeTasks([]);
      updateVisiblePlanDecorations();
    }),
    vscode.workspace.onDidChangeTextDocument(async (event) => {
      if (!isPlanDocument(event.document)) {
        return;
      }
      clearCachedParsedPlan(event.document.uri);
      await refreshFromDocument(event.document);
    }),
    vscode.workspace.onDidSaveTextDocument(async (document) => {
      if (!isPlanDocument(document) || internalWriteDepth > 0) {
        return;
      }
      await syncExecutionQueue(document);
      await refreshPlanUri(document.uri);
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      clearCachedParsedPlan(document.uri);
    }),
    vscode.window.onDidChangeActiveTextEditor(async (editor) => {
      if (editor && isPlanDocument(editor.document)) {
        await refreshFromDocument(editor.document);
      }
      updateVisiblePlanDecorations();
    })
  );

  void (async () => {
    const existing = await findExistingPlanDocument();
    if (existing) {
      await refreshFromDocument(existing);
    }
  })();
}

export function deactivate(): void {}

async function withTreeRequestProgress<T>(
  taskId: string,
  runner: (context: TreeRequestContext) => Promise<T>
): Promise<T | undefined> {
  const requestId = treeProvider.beginTaskRequest(taskId, "Preparing request...");
  const cancellation = new vscode.CancellationTokenSource();
  activeRequestCancellation = cancellation;
  let finalized = false;

  const context: TreeRequestContext = {
    token: cancellation.token,
    report: (detail: string) => {
      treeProvider.updateTaskRequest(requestId, detail);
    },
    complete: (detail: string) => {
      if (finalized) {
        return;
      }
      finalized = true;
      treeProvider.finishTaskRequest(requestId, "success", detail, TREE_REQUEST_SUCCESS_CLEAR_MS);
    },
    cancel: (detail: string) => {
      if (finalized) {
        return;
      }
      finalized = true;
      treeProvider.finishTaskRequest(requestId, "cancelled", detail, TREE_REQUEST_CANCELLED_CLEAR_MS);
    }
  };

  try {
    const result = await runner(context);
    if (!finalized) {
      context.complete("Request completed.");
    }
    return result;
  } catch (error) {
    const message = toErrorMessage(error);
    if (isCancellationMessage(message)) {
      context.cancel(message);
      return undefined;
    }
    treeProvider.finishTaskRequest(requestId, "error", message, TREE_REQUEST_ERROR_CLEAR_MS);
    throw error;
  } finally {
    if (activeRequestCancellation === cancellation) {
      activeRequestCancellation = undefined;
    }
    cancellation.dispose();
  }
}

async function handlePlanTask(arg?: unknown): Promise<void> {
  const { taskRef, doc } = await loadPlanCommandContext(arg);
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  let parsed = parsePlanMarkdown(doc.getText());

  if (parsed.tasks.length === 0) {
    const objective = await vscode.window.showInputBox({
      prompt: "Create your first top-level objective",
      placeHolder: "Build user authentication system"
    });
    if (!objective) {
      return;
    }
    const root = makeTaskNode("T0001", objective, 0, null);
    const latest = await writeAndRefreshPlan(doc.uri, serializePlanMarkdown([root]));
    parsed = parsePlanMarkdown(latest.getText());
  }

  const target = resolveTaskTarget(parsed, taskRef, editor);

  if (!target) {
    vscode.window.showErrorMessage("No task found. Place the cursor on a task line or invoke from a task action.");
    return;
  }

  let mode: "replace" | "refine" = "replace";
  if (target.children.length > 0) {
    const selection = await vscode.window.showQuickPick(
      [
        { label: "Refine existing children", description: "Regenerate with existing context", mode: "refine" as const },
        { label: "Replace existing children", description: "Discard and regenerate", mode: "replace" as const }
      ],
      { placeHolder: `Task ${target.id} already has sub-tasks` }
    );
    if (!selection) {
      return;
    }
    mode = selection.mode;
  }

  try {
    await withTreeRequestProgress(target.id, async (request) => {
      request.report("Collecting task context...");
      const ancestors = collectAncestorChain(parsed.tasks, target.id);
      const relatedFiles = await collectRelevantFiles(target.title, 12);
      const existingChildren = target.children.map((child) => child.title);
      const idFactory = createTaskIdGenerator(parsed.tasks);
      const nodeByTitle = new Map<string, TaskNode>();
      if (mode === "refine") {
        for (const child of target.children) {
          nodeByTitle.set(child.title.trim().toLowerCase(), child);
        }
      }

      let generatedTitles: string[] = [];
      let accumulated = "";
      let wroteAny = false;
      const prompt = buildPlanPrompt(target, ancestors, relatedFiles, existingChildren, mode);
      const lm = await loadLmModule();
      const safePrompt = lm.maskSensitiveText(prompt);
      request.report("Awaiting Copilot consent...");
      const allowPlanRequest = await requestCopilotConsent(`Plan task ${target.id}`, [
        `Selected task: [${target.id}] ${target.title}`,
        `Ancestor tasks included: ${ancestors.length}`,
        `Existing child titles included: ${existingChildren.length}`,
        `Workspace file paths included: ${summarizePathList(relatedFiles, COPILOT_PATH_PREVIEW_LIMIT)}`,
        "Workspace file contents included: none"
      ]);
      if (!allowPlanRequest) {
        request.cancel(`Cancelled planning ${target.id}. No data was sent to Copilot.`);
        return;
      }

      if (mode === "replace") {
        request.report("Replacing existing sub-tasks...");
        target.children = [];
        await writePlanContent(doc.uri, serializePlanMarkdown(parsed.tasks));
      }

      request.report("Requesting one-level plan from Copilot...");
      await lm.streamCopilotText(
        safePrompt,
        async (chunk) => {
          throwIfCancelled(request.token);
          accumulated += chunk;
          const titles = parseAiTaskTitles(accumulated).slice(0, 8);
          const changed = titles.length !== generatedTitles.length || titles.some((value, index) => value !== generatedTitles[index]);
          if (!changed || titles.length === 0) {
            return;
          }

          generatedTitles = titles;
          const nextChildren = generatedTitles.map((title) => {
            const key = title.toLowerCase();
            const existing = nodeByTitle.get(key);
            if (existing) {
              return { ...existing, title, parentId: target.id, depth: target.depth + 1, children: existing.children };
            }
            const created = makeTaskNode(idFactory(), title, target.depth + 1, target.id);
            nodeByTitle.set(key, created);
            return created;
          });

          target.children = nextChildren;
          await writePlanContent(doc.uri, serializePlanMarkdown(parsed.tasks));
          wroteAny = true;
          request.report(`Streaming plan... ${generatedTitles.length} sub-task(s)`);
        },
        request.token
      );
      throwIfCancelled(request.token);

      if (!wroteAny) {
        throwIfCancelled(request.token);
        const fallbackTitles = parseAiTaskTitles(accumulated);
        if (fallbackTitles.length === 0) {
          throw new Error("Copilot response did not contain parseable task bullets.");
        }
        target.children = fallbackTitles.slice(0, 8).map((title) => makeTaskNode(idFactory(), title, target.depth + 1, target.id));
        await writePlanContent(doc.uri, serializePlanMarkdown(parsed.tasks));
      }

      request.report("Refreshing tree...");
      await refreshPlanUri(doc.uri);
      request.complete(`Planned ${target.id} with ${target.children.length} sub-task(s).`);
    });
  } catch (error) {
    vscode.window.showErrorMessage(`Failed planning ${target.id}: ${toErrorMessage(error)}`);
  }
}

async function handleAddTask(arg?: unknown, forceRoot = false): Promise<void> {
  const { taskRef, doc, parsed } = await loadPlanCommandContext(arg);
  const parent = forceRoot ? undefined : resolveTaskTarget(parsed, taskRef, getActivePlanEditor());

  const input = await vscode.window.showInputBox({
    prompt: parent ? `Add child task under ${parent.id}` : "Add top-level task",
    placeHolder: "Describe the task to add"
  });
  const title = input?.trim();
  if (!title) {
    return;
  }

  if (parent && !forceRoot) {
    const nextId = createTaskIdGenerator(parsed.tasks);
    parent.children.push(makeTaskNode(nextId(), title, parent.depth + 1, parent.id));
  } else if (isOnlyBootstrapPlaceholder(parsed.tasks)) {
    parsed.tasks[0].title = title;
    parsed.tasks[0].status = " ";
  } else {
    const nextId = createTaskIdGenerator(parsed.tasks);
    parsed.tasks.push(makeTaskNode(nextId(), title, 0, null));
  }

  await writeAndRefreshPlan(doc.uri, serializePlanMarkdown(parsed.tasks));
  vscode.window.showInformationMessage(`Added task: ${title}`);
}

async function handleDrillDown(arg?: unknown): Promise<void> {
  const { taskRef, doc, parsed } = await loadPlanCommandContext(arg);
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  const target = resolveTaskTarget(parsed, taskRef, editor);

  if (!target) {
    vscode.window.showErrorMessage("No task found to drill down.");
    return;
  }

  const line = Math.max(target.line, 0);
  const position = new vscode.Position(line, 0);
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
}

async function handleImplementTask(arg?: unknown): Promise<void> {
  const { taskRef, doc, parsed } = await loadPlanCommandContext(arg);
  const target = resolveTaskTarget(parsed, taskRef, getActivePlanEditor());

  if (!target) {
    vscode.window.showErrorMessage("No task found to implement.");
    return;
  }

  try {
    await withTreeRequestProgress(target.id, async (request) => {
      request.report("Collecting implementation context...");
      const ancestors = collectAncestorChain(parsed.tasks, target.id);
      const relatedFiles = await collectRelevantFiles(target.title, 20);
      const snapshots = await collectRelevantFileSnapshots(
        relatedFiles,
        MAX_IMPLEMENTATION_SNAPSHOTS,
        MAX_IMPLEMENTATION_FILE_CHARS,
        MAX_IMPLEMENTATION_TOTAL_CHARS
      );
      const prompt = buildImplementPrompt(target, ancestors, relatedFiles, snapshots);
      const lm = await loadLmModule();
      const safePrompt = lm.maskSensitiveText(prompt);
      const snapshotChars = snapshots.reduce((sum, snapshot) => sum + snapshot.content.length, 0);
      request.report("Awaiting Copilot consent...");
      const allowImplementRequest = await requestCopilotConsent(`Implement task ${target.id}`, [
        `Selected task: [${target.id}] ${target.title}`,
        `Ancestor tasks included: ${ancestors.length}`,
        `Workspace file paths included: ${summarizePathList(relatedFiles, COPILOT_PATH_PREVIEW_LIMIT)}`,
        `Workspace file contents included: ${snapshots.length} snapshot(s), ${snapshotChars.toLocaleString()} chars total`,
        `If parsing fails, a repair follow-up may send up to ${MAX_REPAIR_INPUT_CHARS.toLocaleString()} chars from Copilot output`
      ]);
      if (!allowImplementRequest) {
        request.cancel(`Cancelled implementation for ${target.id}. No data was sent to Copilot.`);
        return;
      }

      let modelOutput = "";
      request.report("Requesting implementation edits from Copilot...");
      await lm.streamCopilotText(
        safePrompt,
        async (chunk) => {
          throwIfCancelled(request.token);
          modelOutput += chunk;
          if (modelOutput.length > 0 && modelOutput.length % 1500 < chunk.length) {
            request.report(`Receiving model output... ${modelOutput.length.toLocaleString()} chars`);
          }
        },
        request.token
      );
      throwIfCancelled(request.token);

      request.report("Parsing and validating Copilot response...");
      const payload = await parseImplementationWithRepair(modelOutput, request.token, request.report);
      throwIfCancelled(request.token);

      request.report("Applying generated file changes...");
      const writtenFiles = await applyImplementationChanges(payload);

      // Implement command represents completion for the selected feature scope.
      markTaskSubtreeStatus(target, "x");
      await writeAndRefreshPlan(doc.uri, serializePlanMarkdown(parsed.tasks));

      if (writtenFiles.length > 0) {
        const first = vscode.Uri.joinPath(getWorkspaceRootUri(), ...writtenFiles[0].split("/"));
        const firstDoc = await vscode.workspace.openTextDocument(first);
        await vscode.window.showTextDocument(firstDoc, { preview: false });
      }

      const summarySuffix = payload.summary ? ` ${payload.summary}` : "";
      request.complete(`Implemented ${target.id}: wrote ${writtenFiles.length} file(s).${summarySuffix}`);
    });
  } catch (error) {
    vscode.window.showErrorMessage(`Failed implementing ${target.id}: ${toErrorMessage(error)}`);
  }
}

async function handleDeleteTask(arg?: unknown): Promise<void> {
  const { taskRef, doc, parsed } = await loadPlanCommandContext(arg);
  const target = resolveTaskTarget(parsed, taskRef, getActivePlanEditor());

  if (!target) {
    vscode.window.showErrorMessage("No task found to delete.");
    return;
  }

  const decision = await vscode.window.showWarningMessage(
    `Delete task ${target.id} and all of its sub-tasks?`,
    { modal: true },
    "Delete"
  );
  if (decision !== "Delete") {
    return;
  }

  const removed = deleteTaskById(parsed.tasks, target.id);
  if (!removed) {
    vscode.window.showErrorMessage(`Unable to delete task ${target.id}.`);
    return;
  }

  await writeAndRefreshPlan(doc.uri, serializePlanMarkdown(parsed.tasks));
  vscode.window.showInformationMessage(`Deleted task ${target.id}.`);
}

async function syncExecutionQueue(document: vscode.TextDocument): Promise<void> {
  const parsed = parsePlanMarkdown(document.getText());
  if (parsed.planHeadingLine < 0) {
    return;
  }

  const next = serializePlanMarkdown(parsed.tasks);
  if (next !== document.getText()) {
    await writePlanContent(document.uri, next);
  }
}

async function refreshFromDocument(document: vscode.TextDocument): Promise<void> {
  const parsed = getCachedParsedPlan(document);
  activePlanUri = document.uri;
  setTreeTasks(parsed.tasks, document.uri);
  updateVisiblePlanDecorations();
}

function setTreeTasks(tasks: TaskNode[], sourceUri?: vscode.Uri): void {
  const visibleTasks = isOnlyBootstrapPlaceholder(tasks) ? [] : tasks;
  treeProvider.setTasks(visibleTasks, sourceUri);
  void vscode.commands.executeCommand("setContext", TREE_EMPTY_CONTEXT_KEY, visibleTasks.length === 0);
}

function hasOpenWorkspaceFolder(): boolean {
  return (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
}

function ensureWorkspaceFolderOpen(): boolean {
  if (hasOpenWorkspaceFolder()) {
    return true;
  }
  void vscode.window.showWarningMessage("PlanMyProject requires an open folder or workspace.");
  return false;
}

function updateWorkspaceContext(): void {
  void vscode.commands.executeCommand("setContext", WORKSPACE_OPEN_CONTEXT_KEY, hasOpenWorkspaceFolder());
}

function updateVisiblePlanDecorations(): void {
  for (const editor of vscode.window.visibleTextEditors) {
    if (!isPlanDocument(editor.document)) {
      continue;
    }
    const parsed = getCachedParsedPlan(editor.document);
    const tasks = isOnlyBootstrapPlaceholder(parsed.tasks) ? [] : parsed.tasks;
    const planLines: vscode.DecorationOptions[] = [];
    const executeLines: vscode.DecorationOptions[] = [];

    const leaves = new Set(listLeafTasks(tasks).map((task) => task.id));
    walkTasks(tasks, (task) => {
      if (task.line < 0 || task.line >= editor.document.lineCount) {
        return;
      }
      const range = new vscode.Range(task.line, 0, task.line, 0);
      if (leaves.has(task.id)) {
        executeLines.push({ range });
      } else {
        planLines.push({ range });
      }
    });

    editor.setDecorations(planDecorationType, planLines);
    editor.setDecorations(executeDecorationType, executeLines);
  }
}

async function pickRequirementFileFromRoot(root: vscode.Uri): Promise<vscode.Uri | undefined> {
  const entries = await vscode.workspace.fs.readDirectory(root);
  const candidates = entries
    .filter(([name, type]) => type === vscode.FileType.File && name.toLowerCase().endsWith(".md"))
    .map(([name]) => name)
    .filter((name) => !PLAN_FILENAMES.includes(name.toLowerCase() as (typeof PLAN_FILENAMES)[number]));

  if (candidates.length === 0) {
    vscode.window.showWarningMessage("No markdown requirements file was found in workspace root.");
    return undefined;
  }

  const preferredOrder = new Map<string, number>();
  REQUIREMENT_FILE_HINTS.forEach((name, index) => preferredOrder.set(name, index));
  const sorted = [...candidates].sort((a, b) => {
    const rankA = preferredOrder.get(a.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
    const rankB = preferredOrder.get(b.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
    if (rankA !== rankB) {
      return rankA - rankB;
    }
    return a.localeCompare(b, undefined, { sensitivity: "base" });
  });

  if (sorted.length === 1) {
    return vscode.Uri.joinPath(root, sorted[0]);
  }

  const picked = await vscode.window.showQuickPick(
    sorted.map((name) => ({
      label: name,
      description: preferredOrder.has(name.toLowerCase()) ? "recommended" : undefined
    })),
    { placeHolder: "Select requirements file to import root tasks from" }
  );

  if (!picked) {
    return undefined;
  }
  return vscode.Uri.joinPath(root, picked.label);
}

async function validateRequirementFileContent(uri: vscode.Uri): Promise<boolean> {
  const bytes = await vscode.workspace.fs.readFile(uri);
  const content = Buffer.from(bytes).toString("utf8");
  return hasImportableMarkdownRequirements(content);
}

async function pickLoadableRequirementFile(root: vscode.Uri): Promise<vscode.Uri | undefined> {
  const initial = await pickRequirementFileFromRoot(root);
  if (!initial) {
    return undefined;
  }

  if (await validateRequirementFileContent(initial)) {
    return initial;
  }

  const decision = await vscode.window.showQuickPick(
    [
      { label: "Choose another file", mode: "retry" as const },
      { label: "Use this file anyway", mode: "force" as const }
    ],
    { placeHolder: "Selected file had no obvious task lines. Pick another file or continue." }
  );

  if (!decision) {
    return undefined;
  }
  if (decision.mode === "force") {
    return initial;
  }
  return pickLoadableRequirementFile(root);
}

async function handleLoadRequirementsFile(): Promise<void> {
  const root = getWorkspaceRootUri();
  const requirementFile = await pickLoadableRequirementFile(root);
  if (!requirementFile) {
    return;
  }

  const bytes = await vscode.workspace.fs.readFile(requirementFile);
  const content = Buffer.from(bytes).toString("utf8");
  const importedTitles = extractRootTaskCandidates(content);
  if (importedTitles.length === 0) {
    vscode.window.showWarningMessage(
      "Could not infer root tasks from this file. Try shorter requirement statements or add bullet/numbered lines."
    );
    return;
  }
  const explicitList = hasExplicitRequirementList(content);
  const finalTitles = !explicitList && importedTitles.length > 1
    ? [buildConsolidatedRequirementTitle(requirementFile, importedTitles)]
    : importedTitles;

  const planDoc = await ensurePlanDocument();
  const parsed = parsePlanMarkdown(planDoc.getText());
  const hasExistingTasks = parsed.tasks.length > 0 && !isOnlyBootstrapPlaceholder(parsed.tasks);

  let mode: "replace" | "append" = "replace";
  if (hasExistingTasks) {
    const picked = await vscode.window.showQuickPick(
      [
        { label: "Append imported tasks", description: "Keep existing tasks and add new roots", mode: "append" as const },
        { label: "Replace existing tasks", description: "Discard current tree and import fresh", mode: "replace" as const }
      ],
      { placeHolder: "How should imported requirement tasks be applied?" }
    );
    if (!picked) {
      return;
    }
    mode = picked.mode;
  }

  const nextTasks = mode === "replace" || isOnlyBootstrapPlaceholder(parsed.tasks)
    ? []
    : [...parsed.tasks];
  const nextId = createTaskIdGenerator(nextTasks);
  for (const title of finalTitles) {
    nextTasks.push(makeTaskNode(nextId(), title, 0, null));
  }

  const latest = await writeAndRefreshPlan(planDoc.uri, serializePlanMarkdown(nextTasks));
  await vscode.window.showTextDocument(latest, { preview: false });
  vscode.window.showInformationMessage(
    `Imported ${finalTitles.length} root task(s) from ${vscode.workspace.asRelativePath(requirementFile, false)}.`
  );
}

async function writePlanContent(uri: vscode.Uri, text: string): Promise<vscode.TextDocument> {
  internalWriteDepth += 1;
  try {
    const document = await vscode.workspace.openTextDocument(uri);
    if (document.getText() === text) {
      return document;
    }
    const fullRange = new vscode.Range(
      document.positionAt(0),
      document.positionAt(document.getText().length)
    );
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, fullRange, text);
    await vscode.workspace.applyEdit(edit);
    const latest = await vscode.workspace.openTextDocument(uri);
    await latest.save();
    clearCachedParsedPlan(uri);
    return latest;
  } finally {
    internalWriteDepth -= 1;
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  return "Unknown error.";
}

function isCancellationMessage(message: string): boolean {
  return /^cancel(?:led)?\b/i.test(message.trim());
}

function throwIfCancelled(token: vscode.CancellationToken): void {
  if (token.isCancellationRequested) {
    throw new Error("Cancelled by user.");
  }
}

function summarizePathList(paths: string[], previewLimit: number): string {
  if (paths.length === 0) {
    return "none";
  }

  const preview = paths.slice(0, previewLimit);
  const overflow = paths.length - preview.length;
  const suffix = overflow > 0 ? `, +${overflow} more` : "";
  return `${paths.length} (${preview.join(", ")}${suffix})`;
}

async function requestCopilotConsent(operation: string, summaryLines: string[]): Promise<boolean> {
  if (copilotConsentAllowAll) {
    return true;
  }

  const message = [
    `${operation} sends context to GitHub Copilot.`,
    "Summary of data to be sent:",
    ...summaryLines.map((line) => `- ${line}`),
    "Continue?"
  ].join("\n");
  const decision = await vscode.window.showWarningMessage(
    message,
    { modal: true },
    "Send to Copilot",
    COPILOT_ALLOW_ALL_LABEL
  );
  if (decision === COPILOT_ALLOW_ALL_LABEL) {
    copilotConsentAllowAll = true;
    return true;
  }
  return decision === "Send to Copilot";
}

async function requestSensitiveFileOverrideConsent(paths: string[]): Promise<boolean> {
  const sorted = [...paths].sort((a, b) => a.localeCompare(b));
  const preview = sorted.slice(0, SENSITIVE_FILE_PREVIEW_LIMIT);
  const overflow = sorted.length - preview.length;
  const message = [
    "Copilot generated changes to sensitive workspace files:",
    ...preview.map((filePath) => `- ${filePath}`),
    ...(overflow > 0 ? [`- +${overflow} more file(s)`] : []),
    "These files can alter project, editor, or automation behavior.",
    "Apply sensitive file overrides?"
  ].join("\n");
  const decision = await vscode.window.showWarningMessage(message, { modal: true }, "Apply Sensitive Changes");
  return decision === "Apply Sensitive Changes";
}

async function parseImplementationWithRepair(
  modelOutput: string,
  token: vscode.CancellationToken,
  onStatus?: (detail: string) => void
): Promise<ImplementationPayload> {
  throwIfCancelled(token);
  const implement = await loadImplementModule();
  try {
    return implement.parseImplementationPayload(modelOutput);
  } catch (firstError) {
    if (token.isCancellationRequested) {
      throw firstError;
    }

    onStatus?.("Initial response was invalid JSON. Requesting repair...");
    const repairExcerptLength = Math.min(modelOutput.length, MAX_REPAIR_INPUT_CHARS);
    const allowRepairRequest = await requestCopilotConsent("Repair implementation response", [
      "Reason: the first Copilot response was not valid JSON.",
      `Previous Copilot output excerpt length: ${repairExcerptLength.toLocaleString()} chars`,
      "Additional workspace file contents included: none"
    ]);
    if (!allowRepairRequest) {
      throw new Error("Cancelled implementation: repair request to Copilot was not approved.");
    }

    const repairPrompt = buildImplementRepairPrompt(modelOutput, MAX_REPAIR_INPUT_CHARS);
    const lm = await loadLmModule();
    const safeRepairPrompt = lm.maskSensitiveText(repairPrompt);
    let repaired = "";
    onStatus?.("Waiting for repaired JSON response from Copilot...");
    await lm.streamCopilotText(
      safeRepairPrompt,
      async (chunk) => {
        throwIfCancelled(token);
        repaired += chunk;
      },
      token
    );
    throwIfCancelled(token);
    return implement.parseImplementationPayload(repaired);
  }
}

async function applyImplementationChanges(payload: ImplementationPayload): Promise<string[]> {
  const root = getWorkspaceRootUri();
  const written: string[] = [];
  const finalByPath = new Map<string, string>();

  for (const change of payload.changes) {
    finalByPath.set(change.path, change.content);
  }

  const implement = await loadImplementModule();
  const sensitivePaths = Array.from(finalByPath.keys()).filter((relativePath) => implement.isSensitiveWorkspacePath(relativePath));
  if (sensitivePaths.length > 0) {
    const approved = await requestSensitiveFileOverrideConsent(sensitivePaths);
    if (!approved) {
      throw new Error("Cancelled implementation: sensitive file overrides were not approved.");
    }
  }

  for (const [relativePath, content] of finalByPath.entries()) {
    const targetUri = await resolveWorkspaceWriteTargetUri(root, relativePath);
    const parentDir = path.posix.dirname(relativePath);
    if (parentDir && parentDir !== ".") {
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, ...parentDir.split("/")));
    }
    await vscode.workspace.fs.writeFile(targetUri, Buffer.from(content, "utf8"));
    written.push(relativePath);
  }

  if (written.length === 0) {
    throw new Error("Copilot returned no writable changes.");
  }

  return written;
}


function markTaskSubtreeStatus(task: TaskNode, status: TaskNode["status"]): void {
  task.status = status;
  for (const child of task.children) {
    markTaskSubtreeStatus(child, status);
  }
}

function isOnlyBootstrapPlaceholder(tasks: TaskNode[]): boolean {
  return tasks.length === 1
    && tasks[0].id === "T0001"
    && tasks[0].title === BOOTSTRAP_TASK_TITLE
    && tasks[0].children.length === 0;
}

function deleteTaskById(tasks: TaskNode[], taskId: string): boolean {
  const directIndex = tasks.findIndex((task) => task.id === taskId);
  if (directIndex >= 0) {
    tasks.splice(directIndex, 1);
    return true;
  }

  for (const task of tasks) {
    if (deleteTaskById(task.children, taskId)) {
      return true;
    }
  }
  return false;
}

class PlanCodeLensProvider implements vscode.CodeLensProvider {
  provideCodeLenses(document: vscode.TextDocument): vscode.ProviderResult<vscode.CodeLens[]> {
    if (!isPlanDocument(document)) {
      return [];
    }

    const parsed = getCachedParsedPlan(document);
    const codeLenses: vscode.CodeLens[] = [];

    walkTasks(parsed.tasks, (task) => {
      if (task.line < 0 || task.line >= document.lineCount) {
        return;
      }

      const range = new vscode.Range(task.line, 0, task.line, 0);
      const args = [{ taskId: task.id, fileUri: document.uri.toString() }];
      codeLenses.push(new vscode.CodeLens(range, { command: "planmyproject.planTask", title: "Plan", arguments: args }));
      codeLenses.push(new vscode.CodeLens(range, { command: "planmyproject.drillDown", title: "Drill", arguments: args }));
      codeLenses.push(new vscode.CodeLens(range, { command: "planmyproject.implementTask", title: "Implement", arguments: args }));
    });

    return codeLenses;
  }
}
