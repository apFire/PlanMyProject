import * as path from "path";
import * as vscode from "vscode";
import type { ImplementationPayload } from "./implement";
import {
  TaskNode,
  collectAncestorChain,
  createTaskIdGenerator,
  findTaskById,
  findTaskByLine,
  listLeafTasks,
  makeTaskNode,
  parseAiTaskTitles,
  parsePlanMarkdown,
  serializePlanMarkdown
} from "./model";
import { PlanTreeProvider } from "./tree";

const PLAN_FILENAMES = ["planmyproject.md", "projectplan.md"] as const;
const ROOT_PLAN_GLOB = `{${PLAN_FILENAMES.join(",")}}`;
const DEFAULT_PLAN_FILENAME = PLAN_FILENAMES[0];
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
const MAX_IMPORTED_ROOT_TASKS = 24;
const MIN_IMPORT_TASK_LENGTH = 8;
const MAX_IMPORT_TASK_LENGTH = 180;
const TREE_REQUEST_SUCCESS_CLEAR_MS = 2_500;
const TREE_REQUEST_CANCELLED_CLEAR_MS = 3_000;
const TREE_REQUEST_ERROR_CLEAR_MS = 6_000;
const NON_TASK_HEADING_TITLES = new Set([
  "overview",
  "introduction",
  "background",
  "context",
  "goals",
  "non goals",
  "non-goals",
  "requirements",
  "functional requirements",
  "non functional requirements",
  "non-functional requirements",
  "acceptance criteria",
  "notes",
  "appendix",
  "summary"
]);

let treeProvider: PlanTreeProvider;
let planDecorationType: vscode.TextEditorDecorationType;
let executeDecorationType: vscode.TextEditorDecorationType;
let internalWriteDepth = 0;
let activePlanUri: vscode.Uri | undefined;
let copilotConsentAllowAll = false;
let implementModuleLoader: Promise<typeof import("./implement")> | undefined;
let lmModuleLoader: Promise<typeof import("./lm")> | undefined;

interface TaskCommandRef {
  taskId?: string;
  fileUri?: vscode.Uri;
}

interface FileSnapshot {
  path: string;
  content: string;
  truncated: boolean;
}

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

  context.subscriptions.push(
    vscode.commands.registerCommand("planmyproject.openPlan", async () => {
      if (!ensureWorkspaceFolderOpen()) {
        return;
      }
      const doc = await ensurePlanDocument();
      await vscode.window.showTextDocument(doc, { preview: false });
      await refreshFromDocument(doc);
    }),
    vscode.commands.registerCommand("planmyproject.planTask", async (arg?: unknown) => {
      if (!ensureWorkspaceFolderOpen()) {
        return;
      }
      await handlePlanTask(arg);
    }),
    vscode.commands.registerCommand("planmyproject.addTask", async (arg?: unknown) => {
      if (!ensureWorkspaceFolderOpen()) {
        return;
      }
      await handleAddTask(arg);
    }),
    vscode.commands.registerCommand("planmyproject.addRootTask", async () => {
      if (!ensureWorkspaceFolderOpen()) {
        return;
      }
      await handleAddTask(undefined, true);
    }),
    vscode.commands.registerCommand("planmyproject.loadRequirementsFile", async () => {
      if (!ensureWorkspaceFolderOpen()) {
        return;
      }
      await handleLoadRequirementsFile();
    }),
    vscode.commands.registerCommand("planmyproject.drillDown", async (arg?: unknown) => {
      if (!ensureWorkspaceFolderOpen()) {
        return;
      }
      await handleDrillDown(arg);
    }),
    vscode.commands.registerCommand("planmyproject.implementTask", async (arg?: unknown) => {
      if (!ensureWorkspaceFolderOpen()) {
        return;
      }
      await handleImplementTask(arg);
    }),
    vscode.commands.registerCommand("planmyproject.deleteTask", async (arg?: unknown) => {
      if (!ensureWorkspaceFolderOpen()) {
        return;
      }
      await handleDeleteTask(arg);
    }),
    vscode.commands.registerCommand("planmyproject.rebuildQueue", async () => {
      if (!ensureWorkspaceFolderOpen()) {
        return;
      }
      const doc = await resolvePlanDocumentForCommand();
      await syncExecutionQueue(doc);
      await refreshFromDocument(await vscode.workspace.openTextDocument(doc.uri));
    }),
    vscode.commands.registerCommand("planmyproject.refreshTree", async () => {
      if (!ensureWorkspaceFolderOpen()) {
        return;
      }
      const doc = await findExistingPlanDocument();
      if (doc) {
        await refreshFromDocument(doc);
      }
    })
  );

  const watcher = vscode.workspace.createFileSystemWatcher(ROOT_PLAN_GLOB);
  context.subscriptions.push(
    watcher,
    watcher.onDidCreate(async (uri) => {
      const doc = await vscode.workspace.openTextDocument(uri);
      await refreshFromDocument(doc);
    }),
    watcher.onDidChange(async (uri) => {
      const doc = await vscode.workspace.openTextDocument(uri);
      await refreshFromDocument(doc);
    }),
    watcher.onDidDelete(async () => {
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
      await refreshFromDocument(event.document);
    }),
    vscode.workspace.onDidSaveTextDocument(async (document) => {
      if (!isPlanDocument(document) || internalWriteDepth > 0) {
        return;
      }
      await syncExecutionQueue(document);
      const latest = await vscode.workspace.openTextDocument(document.uri);
      await refreshFromDocument(latest);
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
  title: string,
  runner: (context: TreeRequestContext) => Promise<T>
): Promise<T | undefined> {
  const requestId = treeProvider.beginRequest(title, "Preparing request...");
  const cancellation = new vscode.CancellationTokenSource();
  let finalized = false;

  const context: TreeRequestContext = {
    token: cancellation.token,
    report: (detail: string) => {
      treeProvider.updateRequest(requestId, detail);
    },
    complete: (detail: string) => {
      if (finalized) {
        return;
      }
      finalized = true;
      treeProvider.finishRequest(requestId, "success", detail, TREE_REQUEST_SUCCESS_CLEAR_MS);
    },
    cancel: (detail: string) => {
      if (finalized) {
        return;
      }
      finalized = true;
      treeProvider.finishRequest(requestId, "cancelled", detail, TREE_REQUEST_CANCELLED_CLEAR_MS);
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
    treeProvider.finishRequest(requestId, "error", message, TREE_REQUEST_ERROR_CLEAR_MS);
    throw error;
  } finally {
    cancellation.dispose();
  }
}

async function handlePlanTask(arg?: unknown): Promise<void> {
  const taskRef = extractTaskCommandRef(arg);
  const doc = await resolvePlanDocumentForCommand(taskRef);
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
    await writePlanContent(doc.uri, serializePlanMarkdown([root]));
    parsed = parsePlanMarkdown((await vscode.workspace.openTextDocument(doc.uri)).getText());
  }

  const taskId = taskRef.taskId;
  const target = taskId ? findTaskById(parsed.tasks, taskId) : findTaskByLine(parsed.tasks, editor.selection.active.line);

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
    await withTreeRequestProgress(`Planning ${target.id}`, async (request) => {
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
          if (request.token.isCancellationRequested) {
            return;
          }
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

      if (!wroteAny) {
        const fallbackTitles = parseAiTaskTitles(accumulated);
        if (fallbackTitles.length === 0) {
          throw new Error("Copilot response did not contain parseable task bullets.");
        }
        target.children = fallbackTitles.slice(0, 8).map((title) => makeTaskNode(idFactory(), title, target.depth + 1, target.id));
        await writePlanContent(doc.uri, serializePlanMarkdown(parsed.tasks));
      }

      request.report("Refreshing tree...");
      const latestDoc = await vscode.workspace.openTextDocument(doc.uri);
      await refreshFromDocument(latestDoc);
      request.complete(`Planned ${target.id} with ${target.children.length} sub-task(s).`);
    });
  } catch (error) {
    vscode.window.showErrorMessage(`Failed planning ${target.id}: ${toErrorMessage(error)}`);
  }
}

async function handleAddTask(arg?: unknown, forceRoot = false): Promise<void> {
  const taskRef = extractTaskCommandRef(arg);
  const doc = await resolvePlanDocumentForCommand(taskRef);
  const parsed = parsePlanMarkdown(doc.getText());
  const activeEditor = vscode.window.activeTextEditor;
  const taskId = taskRef.taskId;
  const parent = forceRoot
    ? undefined
    : taskId
      ? findTaskById(parsed.tasks, taskId)
      : activeEditor && isPlanDocument(activeEditor.document)
        ? findTaskByLine(parsed.tasks, activeEditor.selection.active.line)
        : undefined;

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

  await writePlanContent(doc.uri, serializePlanMarkdown(parsed.tasks));
  const latest = await vscode.workspace.openTextDocument(doc.uri);
  await refreshFromDocument(latest);
  vscode.window.showInformationMessage(`Added task: ${title}`);
}

async function handleDrillDown(arg?: unknown): Promise<void> {
  const taskRef = extractTaskCommandRef(arg);
  const doc = await resolvePlanDocumentForCommand(taskRef);
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  const parsed = parsePlanMarkdown(doc.getText());
  const taskId = taskRef.taskId;
  const target = taskId ? findTaskById(parsed.tasks, taskId) : findTaskByLine(parsed.tasks, editor.selection.active.line);

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
  const taskRef = extractTaskCommandRef(arg);
  const doc = await resolvePlanDocumentForCommand(taskRef);
  const parsed = parsePlanMarkdown(doc.getText());
  const activeEditor = vscode.window.activeTextEditor;
  const taskId = taskRef.taskId;
  const target = taskId
    ? findTaskById(parsed.tasks, taskId)
    : activeEditor && isPlanDocument(activeEditor.document)
      ? findTaskByLine(parsed.tasks, activeEditor.selection.active.line)
      : undefined;

  if (!target) {
    vscode.window.showErrorMessage("No task found to implement.");
    return;
  }

  try {
    await withTreeRequestProgress(`Implementing ${target.id}`, async (request) => {
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
          if (request.token.isCancellationRequested) {
            return;
          }
          modelOutput += chunk;
          if (modelOutput.length > 0 && modelOutput.length % 1500 < chunk.length) {
            request.report(`Receiving model output... ${modelOutput.length.toLocaleString()} chars`);
          }
        },
        request.token
      );

      request.report("Parsing and validating Copilot response...");
      const payload = await parseImplementationWithRepair(modelOutput, request.token, request.report);

      request.report("Applying generated file changes...");
      const writtenFiles = await applyImplementationChanges(payload);

      // Implement command represents completion for the selected feature scope.
      markTaskSubtreeStatus(target, "x");
      await writePlanContent(doc.uri, serializePlanMarkdown(parsed.tasks));
      const refreshedDoc = await vscode.workspace.openTextDocument(doc.uri);
      await refreshFromDocument(refreshedDoc);

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
  const taskRef = extractTaskCommandRef(arg);
  const doc = await resolvePlanDocumentForCommand(taskRef);
  const parsed = parsePlanMarkdown(doc.getText());
  const activeEditor = vscode.window.activeTextEditor;
  const taskId = taskRef.taskId;
  const target = taskId
    ? findTaskById(parsed.tasks, taskId)
    : activeEditor && isPlanDocument(activeEditor.document)
      ? findTaskByLine(parsed.tasks, activeEditor.selection.active.line)
      : undefined;

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

  await writePlanContent(doc.uri, serializePlanMarkdown(parsed.tasks));
  const latest = await vscode.workspace.openTextDocument(doc.uri);
  await refreshFromDocument(latest);
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
  const parsed = parsePlanMarkdown(document.getText());
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
    const parsed = parsePlanMarkdown(editor.document.getText());
    const tasks = isOnlyBootstrapPlaceholder(parsed.tasks) ? [] : parsed.tasks;
    const planLines: vscode.DecorationOptions[] = [];
    const executeLines: vscode.DecorationOptions[] = [];

    const leaves = new Set(listLeafTasks(tasks).map((task) => task.id));
    walk(tasks, (task) => {
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

async function ensurePlanDocument(preferredUri?: vscode.Uri): Promise<vscode.TextDocument> {
  if (preferredUri && isSupportedPlanUri(preferredUri)) {
    if (!(await uriExists(preferredUri))) {
      await vscode.workspace.fs.writeFile(preferredUri, Buffer.from(serializePlanMarkdown([]), "utf8"));
    }
    return vscode.workspace.openTextDocument(preferredUri);
  }

  const existing = await findExistingPlanDocument();
  if (existing) {
    return existing;
  }

  const root = getWorkspaceRootUri();
  const uri = vscode.Uri.joinPath(root, DEFAULT_PLAN_FILENAME);
  await vscode.workspace.fs.writeFile(uri, Buffer.from(serializePlanMarkdown([]), "utf8"));
  return vscode.workspace.openTextDocument(uri);
}

async function resolvePlanDocumentForCommand(taskRef?: TaskCommandRef): Promise<vscode.TextDocument> {
  const taskId = taskRef?.taskId;
  const candidates: vscode.Uri[] = [];
  const pushCandidate = (uri?: vscode.Uri): void => {
    if (!uri || !isSupportedPlanUri(uri)) {
      return;
    }
    const key = uri.toString();
    if (!candidates.some((existing) => existing.toString() === key)) {
      candidates.push(uri);
    }
  };

  pushCandidate(taskRef?.fileUri);

  const activeDoc = vscode.window.activeTextEditor?.document;
  if (activeDoc && isPlanDocument(activeDoc)) {
    pushCandidate(activeDoc.uri);
  }

  pushCandidate(activePlanUri);

  const existingUris = await findExistingPlanUris();
  for (const uri of existingUris) {
    pushCandidate(uri);
  }

  for (const uri of candidates) {
    const doc = await vscode.workspace.openTextDocument(uri);
    if (!taskId) {
      return doc;
    }
    const parsed = parsePlanMarkdown(doc.getText());
    if (findTaskById(parsed.tasks, taskId)) {
      return doc;
    }
  }

  return ensurePlanDocument(taskRef?.fileUri);
}

async function findExistingPlanDocument(): Promise<vscode.TextDocument | undefined> {
  const uris = await findExistingPlanUris();
  if (uris.length === 0) {
    return undefined;
  }
  return vscode.workspace.openTextDocument(uris[0]);
}

async function findExistingPlanUris(): Promise<vscode.Uri[]> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) {
    return [];
  }

  const result: vscode.Uri[] = [];
  for (const name of PLAN_FILENAMES) {
    const uri = vscode.Uri.joinPath(root, name);
    if (await uriExists(uri)) {
      result.push(uri);
    }
  }
  return result;
}

function getWorkspaceRootUri(): vscode.Uri {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) {
    throw new Error("PlanMyProject requires an open folder or workspace.");
  }
  return root;
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

function extractRootTaskCandidates(markdown: string): string[] {
  const lines = markdown.split(/\r?\n/);
  const titles: string[] = [];
  const seen = new Set<string>();
  let inCodeBlock = false;
  let paragraphBuffer: string[] = [];

  const flushParagraph = (): void => {
    if (paragraphBuffer.length === 0) {
      return;
    }
    const paragraph = paragraphBuffer.join(" ").replace(/\s+/g, " ").trim();
    paragraphBuffer = [];
    if (!paragraph) {
      return;
    }
    pushCandidate(paragraph, titles, seen);
    if (titles.length >= MAX_IMPORTED_ROOT_TASKS) {
      return;
    }
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith("```")) {
      flushParagraph();
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) {
      continue;
    }

    if (!trimmed) {
      flushParagraph();
      continue;
    }

    if (/^<!--.*-->$/.test(trimmed)) {
      continue;
    }

    const heading = /^#{1,6}\s+(.+)$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      continue;
    }

    const listMatch = /^[-*+]\s+(.+)$/.exec(rawLine) ?? /^\d+[.)]\s+(.+)$/.exec(trimmed);
    if (listMatch) {
      flushParagraph();
      pushCandidate(listMatch[1], titles, seen);
      if (titles.length >= MAX_IMPORTED_ROOT_TASKS) {
        break;
      }
      continue;
    }

    paragraphBuffer.push(trimmed);
    if (/[.!?]$/.test(trimmed)) {
      flushParagraph();
    }
    if (titles.length >= MAX_IMPORTED_ROOT_TASKS) {
      break;
    }
  }

  flushParagraph();
  return titles.slice(0, MAX_IMPORTED_ROOT_TASKS);
}

function pushCandidate(rawValue: string, titles: string[], seen: Set<string>): void {
  const title = normalizeImportedTaskTitle(rawValue);
  if (!title || isGenericHeadingTitle(title)) {
    return;
  }

  const key = title.toLowerCase();
  if (seen.has(key)) {
    return;
  }

  seen.add(key);
  titles.push(title);
}

function isGenericHeadingTitle(value: string): boolean {
  const normalized = value
    .toLowerCase()
    .replace(/[:\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return NON_TASK_HEADING_TITLES.has(normalized);
}

function normalizeImportedTaskTitle(value: string): string | undefined {
  const compact = value
    .replace(/^\s*[-*+\d.)]+\s+/, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/^[\[\(]+/, "")
    .replace(/[\]\)]+$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.:;,\-]+$/, "")
    .trim();

  if (compact.length < MIN_IMPORT_TASK_LENGTH || compact.length > MAX_IMPORT_TASK_LENGTH) {
    return undefined;
  }

  if (/^(?:epic|story|task|item)\s+\d+$/i.test(compact)) {
    return undefined;
  }

  // Avoid importing pure metadata lines like "Owner: X" as root requirements.
  if (/^[A-Za-z][A-Za-z0-9 _-]{0,24}:\s+\S+/.test(compact)) {
    return undefined;
  }

  return compact;
}

function hasImportableMarkdownRequirements(markdown: string): boolean {
  return extractRootTaskCandidates(markdown).length > 0;
}

async function validateRequirementFileContent(uri: vscode.Uri): Promise<boolean> {
  const bytes = await vscode.workspace.fs.readFile(uri);
  const content = Buffer.from(bytes).toString("utf8");
  return hasImportableMarkdownRequirements(content);
}

function hasExplicitRequirementList(markdown: string): boolean {
  const lines = markdown.split(/\r?\n/);
  let inCodeBlock = false;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) {
      continue;
    }
    if (/^[-*+]\s+.+/.test(rawLine) || /^\d+[.)]\s+.+/.test(trimmed)) {
      return true;
    }
  }

  return false;
}

function buildConsolidatedRequirementTitle(requirementFile: vscode.Uri, candidates: string[]): string {
  const stem = path.parse(requirementFile.fsPath).name.replace(/[_-]+/g, " ").trim();
  if (stem.length >= 3) {
    return `Implement requirements from ${stem}`;
  }
  return candidates[0];
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

  await writePlanContent(planDoc.uri, serializePlanMarkdown(nextTasks));
  const latest = await vscode.workspace.openTextDocument(planDoc.uri);
  await vscode.window.showTextDocument(latest, { preview: false });
  await refreshFromDocument(latest);
  vscode.window.showInformationMessage(
    `Imported ${finalTitles.length} root task(s) from ${vscode.workspace.asRelativePath(requirementFile, false)}.`
  );
}

async function writePlanContent(uri: vscode.Uri, text: string): Promise<void> {
  internalWriteDepth += 1;
  try {
    const document = await vscode.workspace.openTextDocument(uri);
    if (document.getText() === text) {
      return;
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
  } finally {
    internalWriteDepth -= 1;
  }
}

function isPlanDocument(document: vscode.TextDocument): boolean {
  return isSupportedPlanUri(document.uri);
}

function isSupportedPlanUri(uri: vscode.Uri): boolean {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root || uri.scheme !== "file") {
    return false;
  }
  const name = path.basename(uri.fsPath).toLowerCase();
  if (!PLAN_FILENAMES.includes(name as (typeof PLAN_FILENAMES)[number])) {
    return false;
  }
  return path.resolve(path.dirname(uri.fsPath)) === path.resolve(root.fsPath);
}

function extractTaskCommandRef(arg?: unknown): TaskCommandRef {
  const ref: TaskCommandRef = {};
  if (!arg) {
    return ref;
  }

  if (typeof arg === "string") {
    ref.taskId = arg;
    return ref;
  }

  if (Array.isArray(arg) && typeof arg[0] === "string") {
    ref.taskId = arg[0];
    return ref;
  }

  if (typeof arg === "object") {
    const value = arg as Record<string, unknown>;
    if (typeof value.taskId === "string") {
      ref.taskId = value.taskId;
    } else if (typeof value.id === "string") {
      ref.taskId = value.id;
    } else if (typeof value.label === "string") {
      ref.taskId = value.label;
    }

    const uriCandidate = toUri(value.fileUri)
      ?? toUri(value.resourceUri)
      ?? toUri(value.uri);
    if (uriCandidate && isSupportedPlanUri(uriCandidate)) {
      ref.fileUri = uriCandidate;
    }
  }

  return ref;
}

function toUri(candidate: unknown): vscode.Uri | undefined {
  if (candidate instanceof vscode.Uri) {
    return candidate;
  }
  if (typeof candidate !== "string") {
    return undefined;
  }
  const trimmed = candidate.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith("file:") || trimmed.includes("://")) {
    try {
      return vscode.Uri.parse(trimmed, true);
    } catch {
      return undefined;
    }
  }
  if (path.isAbsolute(trimmed)) {
    return vscode.Uri.file(trimmed);
  }
  return undefined;
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

async function uriExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function collectRelevantFiles(taskTitle: string, maxResults: number): Promise<string[]> {
  const workspace = vscode.workspace.workspaceFolders?.[0];
  if (!workspace) {
    return [];
  }

  const files = await vscode.workspace.findFiles(
    "**/*",
    "{**/.git/**,**/node_modules/**,**/dist/**,**/out/**,**/build/**,**/.next/**}",
    350
  );

  const tokens = taskTitle
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4);

  const relative = files.map((uri) => vscode.workspace.asRelativePath(uri, false));
  const filtered = tokens.length
    ? relative.filter((file) => tokens.some((token) => file.toLowerCase().includes(token)))
    : [];

  const selected = filtered.length > 0 ? filtered : relative;
  return selected.slice(0, maxResults);
}

async function collectRelevantFileSnapshots(
  filePaths: string[],
  maxFiles: number,
  perFileLimit: number,
  totalLimit: number
): Promise<FileSnapshot[]> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) {
    return [];
  }

  const snapshots: FileSnapshot[] = [];
  let totalChars = 0;

  for (const relativePath of filePaths) {
    if (snapshots.length >= maxFiles || totalChars >= totalLimit) {
      break;
    }
    if (!relativePath || relativePath.endsWith(".png") || relativePath.endsWith(".jpg") || relativePath.endsWith(".svg")) {
      continue;
    }

    try {
      const uri = vscode.Uri.joinPath(root, ...relativePath.split("/"));
      const bytes = await vscode.workspace.fs.readFile(uri);
      const content = Buffer.from(bytes).toString("utf8");
      if (content.includes("\u0000")) {
        continue;
      }
      const remaining = Math.max(totalLimit - totalChars, 0);
      if (remaining === 0) {
        break;
      }
      const allowed = Math.min(perFileLimit, remaining);
      const truncated = content.length > allowed;
      const trimmed = content.slice(0, allowed);
      snapshots.push({ path: relativePath, content: trimmed, truncated });
      totalChars += trimmed.length;
    } catch {
      // Skip unreadable files and continue collecting context.
    }
  }

  return snapshots;
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

    const repairPrompt = buildImplementRepairPrompt(modelOutput);
    const lm = await loadLmModule();
    const safeRepairPrompt = lm.maskSensitiveText(repairPrompt);
    let repaired = "";
    onStatus?.("Waiting for repaired JSON response from Copilot...");
    await lm.streamCopilotText(
      safeRepairPrompt,
      async (chunk) => {
        if (token.isCancellationRequested) {
          return;
        }
        repaired += chunk;
      },
      token
    );
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
    const targetUri = vscode.Uri.joinPath(root, ...relativePath.split("/"));
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

function buildPlanPrompt(
  target: TaskNode,
  ancestors: TaskNode[],
  relatedFiles: string[],
  existingChildren: string[],
  mode: "replace" | "refine"
): string {
  const hierarchy = ancestors.map((node, index) => `${index + 1}. [${node.id}] ${node.title}`).join("\n");
  const childContext = existingChildren.length
    ? existingChildren.map((item, index) => `${index + 1}. ${item}`).join("\n")
    : "(none)";
  const filesContext = relatedFiles.length > 0 ? relatedFiles.join("\n") : "(no file hints available)";

  return [
    "You are a planning assistant for software implementation tasks.",
    "Output only one level of immediate child tasks for the selected task.",
    "Do not create nested bullets.",
    "Return exactly 3 to 5 bullet points using '- ' format.",
    "Each bullet must be concise and actionable.",
    "",
    `Mode: ${mode}`,
    `Selected Task: [${target.id}] ${target.title}`,
    "",
    "Ancestor chain (root to selected):",
    hierarchy,
    "",
    "Existing children (if any):",
    childContext,
    "",
    "Potentially relevant files from codebase:",
    filesContext,
    "",
    "Constraints:",
    "- Plan exactly one level under the selected task.",
    "- No explanations, no code block, no numbering.",
    "- Keep each task focused enough for implementation execution."
  ].join("\n");
}

function buildImplementPrompt(
  target: TaskNode,
  ancestors: TaskNode[],
  relatedFiles: string[],
  snapshots: FileSnapshot[]
): string {
  const hierarchy = ancestors.map((node, index) => `${index + 1}. [${node.id}] ${node.title}`).join("\n");
  const filesContext = relatedFiles.length > 0 ? relatedFiles.join("\n") : "(no file hints available)";
  const snapshotContext = snapshots.length > 0
    ? snapshots.map((snapshot) => {
      const escaped = snapshot.content.replace(/```/g, "``\\`");
      const truncation = snapshot.truncated ? "\n// [truncated]" : "";
      return [
        `File: ${snapshot.path}`,
        "```",
        `${escaped}${truncation}`,
        "```"
      ].join("\n");
    }).join("\n\n")
    : "(no file snapshots available)";

  return [
    "You are an implementation agent for a VS Code project workspace.",
    "Implement the selected task by returning file writes that can be applied directly.",
    "Respond with JSON only, no markdown and no commentary.",
    "",
    `Selected Task: [${target.id}] ${target.title}`,
    "",
    "Task hierarchy context:",
    hierarchy,
    "",
    "Potentially relevant file paths:",
    filesContext,
    "",
    "Existing file snapshots:",
    snapshotContext,
    "",
    "Required JSON schema:",
    "{",
    "  \"summary\": \"short summary\",",
    "  \"taskCompleted\": true,",
    "  \"changes\": [",
    "    { \"path\": \"src/file.ts\", \"content\": \"full updated file content\" }",
    "  ],",
    "  \"tests\": [\"commands or checks you ran or recommend\"],",
    "  \"risks\": [\"known limitations\"]",
    "}",
    "",
    "Rules:",
    "- Use only workspace-relative paths.",
    "- Do not use absolute paths.",
    "- Do not use '..' segments.",
    "- For every change entry, include the full file content, not a patch.",
    "- Include at least one change."
  ].join("\n");
}

function buildImplementRepairPrompt(output: string): string {
  const trimmedOutput = output.slice(0, MAX_REPAIR_INPUT_CHARS);
  return [
    "Convert the following text into STRICT JSON only.",
    "Do not include markdown fences or any extra words.",
    "Return this exact schema:",
    "{",
    "  \"summary\": \"short summary\",",
    "  \"taskCompleted\": true,",
    "  \"changes\": [",
    "    { \"path\": \"src/file.ts\", \"content\": \"full updated file content\" }",
    "  ],",
    "  \"tests\": [\"...\"] ,",
    "  \"risks\": [\"...\"]",
    "}",
    "If data is missing, infer best effort values but keep at least one change item.",
    "",
    "Text to convert:",
    trimmedOutput
  ].join("\n");
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

function walk(tasks: TaskNode[], visitor: (task: TaskNode) => void): void {
  for (const task of tasks) {
    visitor(task);
    walk(task.children, visitor);
  }
}

class PlanCodeLensProvider implements vscode.CodeLensProvider {
  provideCodeLenses(document: vscode.TextDocument): vscode.ProviderResult<vscode.CodeLens[]> {
    if (!isPlanDocument(document)) {
      return [];
    }

    const parsed = parsePlanMarkdown(document.getText());
    const codeLenses: vscode.CodeLens[] = [];

    walk(parsed.tasks, (task) => {
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
