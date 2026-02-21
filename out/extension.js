"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const implement_1 = require("./implement");
const lm_1 = require("./lm");
const model_1 = require("./model");
const tree_1 = require("./tree");
const PLAN_FILENAMES = ["planmyproject.md", "projectplan.md"];
const DEFAULT_PLAN_FILENAME = PLAN_FILENAMES[0];
const MAX_IMPLEMENTATION_SNAPSHOTS = 8;
const MAX_IMPLEMENTATION_FILE_CHARS = 14_000;
const MAX_IMPLEMENTATION_TOTAL_CHARS = 52_000;
const MAX_REPAIR_INPUT_CHARS = 32_000;
const BOOTSTRAP_TASK_TITLE = "Add your first objective";
let treeProvider;
let planDecorationType;
let executeDecorationType;
let internalWriteDepth = 0;
let activePlanUri;
function activate(context) {
    treeProvider = new tree_1.PlanTreeProvider();
    context.subscriptions.push(vscode.window.registerTreeDataProvider("planmyproject.tree", treeProvider));
    context.subscriptions.push(vscode.languages.registerCodeLensProvider([{ scheme: "file", pattern: `**/{${PLAN_FILENAMES.join(",")}}` }], new PlanCodeLensProvider()));
    planDecorationType = vscode.window.createTextEditorDecorationType({
        gutterIconPath: vscode.Uri.file(path.join(context.extensionPath, "media", "plan.svg")),
        gutterIconSize: "16px"
    });
    executeDecorationType = vscode.window.createTextEditorDecorationType({
        gutterIconPath: vscode.Uri.file(path.join(context.extensionPath, "media", "execute.svg")),
        gutterIconSize: "16px"
    });
    context.subscriptions.push(planDecorationType, executeDecorationType);
    context.subscriptions.push(vscode.commands.registerCommand("planmyproject.openPlan", async () => {
        const doc = await ensurePlanDocument();
        await vscode.window.showTextDocument(doc, { preview: false });
        await refreshFromDocument(doc);
    }), vscode.commands.registerCommand("planmyproject.planTask", async (arg) => {
        await handlePlanTask(arg);
    }), vscode.commands.registerCommand("planmyproject.addTask", async (arg) => {
        await handleAddTask(arg);
    }), vscode.commands.registerCommand("planmyproject.drillDown", async (arg) => {
        await handleDrillDown(arg);
    }), vscode.commands.registerCommand("planmyproject.implementTask", async (arg) => {
        await handleImplementTask(arg);
    }), vscode.commands.registerCommand("planmyproject.deleteTask", async (arg) => {
        await handleDeleteTask(arg);
    }), vscode.commands.registerCommand("planmyproject.rebuildQueue", async () => {
        const doc = await resolvePlanDocumentForCommand();
        await syncExecutionQueue(doc);
        await refreshFromDocument(await vscode.workspace.openTextDocument(doc.uri));
    }), vscode.commands.registerCommand("planmyproject.refreshTree", async () => {
        const doc = await findExistingPlanDocument();
        if (doc) {
            await refreshFromDocument(doc);
        }
    }));
    const watcher = vscode.workspace.createFileSystemWatcher(`**/{${PLAN_FILENAMES.join(",")}}`);
    context.subscriptions.push(watcher, watcher.onDidCreate(async (uri) => {
        const doc = await vscode.workspace.openTextDocument(uri);
        await refreshFromDocument(doc);
    }), watcher.onDidChange(async (uri) => {
        const doc = await vscode.workspace.openTextDocument(uri);
        await refreshFromDocument(doc);
    }), watcher.onDidDelete(async () => {
        const doc = await findExistingPlanDocument();
        if (doc) {
            await refreshFromDocument(doc);
            return;
        }
        activePlanUri = undefined;
        treeProvider.setTasks([]);
        updateVisiblePlanDecorations();
    }));
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(async (event) => {
        if (!isPlanDocument(event.document)) {
            return;
        }
        await refreshFromDocument(event.document);
    }), vscode.workspace.onDidSaveTextDocument(async (document) => {
        if (!isPlanDocument(document) || internalWriteDepth > 0) {
            return;
        }
        await syncExecutionQueue(document);
        const latest = await vscode.workspace.openTextDocument(document.uri);
        await refreshFromDocument(latest);
    }), vscode.window.onDidChangeActiveTextEditor(async (editor) => {
        if (editor && isPlanDocument(editor.document)) {
            await refreshFromDocument(editor.document);
        }
        updateVisiblePlanDecorations();
    }));
    void (async () => {
        const existing = await findExistingPlanDocument();
        if (existing) {
            await refreshFromDocument(existing);
        }
    })();
}
function deactivate() { }
async function handlePlanTask(arg) {
    const taskRef = extractTaskCommandRef(arg);
    const doc = await resolvePlanDocumentForCommand(taskRef);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    let parsed = (0, model_1.parsePlanMarkdown)(doc.getText());
    if (parsed.tasks.length === 0) {
        const objective = await vscode.window.showInputBox({
            prompt: "Create your first top-level objective",
            placeHolder: "Build user authentication system"
        });
        if (!objective) {
            return;
        }
        const root = (0, model_1.makeTaskNode)("T0001", objective, 0, null);
        await writePlanContent(doc.uri, (0, model_1.serializePlanMarkdown)([root]));
        parsed = (0, model_1.parsePlanMarkdown)((await vscode.workspace.openTextDocument(doc.uri)).getText());
    }
    const taskId = taskRef.taskId;
    const target = taskId ? (0, model_1.findTaskById)(parsed.tasks, taskId) : (0, model_1.findTaskByLine)(parsed.tasks, editor.selection.active.line);
    if (!target) {
        vscode.window.showErrorMessage("No task found. Place the cursor on a task line or invoke from a task action.");
        return;
    }
    let mode = "replace";
    if (target.children.length > 0) {
        const selection = await vscode.window.showQuickPick([
            { label: "Refine existing children", description: "Regenerate with existing context", mode: "refine" },
            { label: "Replace existing children", description: "Discard and regenerate", mode: "replace" }
        ], { placeHolder: `Task ${target.id} already has sub-tasks` });
        if (!selection) {
            return;
        }
        mode = selection.mode;
    }
    await vscode.window.withProgress({
        title: `Planning ${target.id}`,
        location: vscode.ProgressLocation.Notification,
        cancellable: true
    }, async (progress, token) => {
        const ancestors = (0, model_1.collectAncestorChain)(parsed.tasks, target.id);
        const relatedFiles = await collectRelevantFiles(target.title, 12);
        const existingChildren = target.children.map((child) => child.title);
        const idFactory = (0, model_1.createTaskIdGenerator)(parsed.tasks);
        const nodeByTitle = new Map();
        if (mode === "refine") {
            for (const child of target.children) {
                nodeByTitle.set(child.title.trim().toLowerCase(), child);
            }
        }
        let generatedTitles = [];
        let accumulated = "";
        let wroteAny = false;
        const prompt = buildPlanPrompt(target, ancestors, relatedFiles, existingChildren, mode);
        const safePrompt = (0, lm_1.maskSensitiveText)(prompt);
        if (mode === "replace") {
            target.children = [];
            await writePlanContent(doc.uri, (0, model_1.serializePlanMarkdown)(parsed.tasks));
        }
        progress.report({ message: "Requesting one-level plan from Copilot..." });
        await (0, lm_1.streamCopilotText)(safePrompt, async (chunk) => {
            if (token.isCancellationRequested) {
                return;
            }
            accumulated += chunk;
            const titles = (0, model_1.parseAiTaskTitles)(accumulated).slice(0, 8);
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
                const created = (0, model_1.makeTaskNode)(idFactory(), title, target.depth + 1, target.id);
                nodeByTitle.set(key, created);
                return created;
            });
            target.children = nextChildren;
            await writePlanContent(doc.uri, (0, model_1.serializePlanMarkdown)(parsed.tasks));
            wroteAny = true;
            progress.report({ message: `Streaming plan... ${generatedTitles.length} sub-task(s)` });
        }, token);
        if (!wroteAny) {
            const fallbackTitles = (0, model_1.parseAiTaskTitles)(accumulated);
            if (fallbackTitles.length === 0) {
                throw new Error("Copilot response did not contain parseable task bullets.");
            }
            target.children = fallbackTitles.slice(0, 8).map((title) => (0, model_1.makeTaskNode)(idFactory(), title, target.depth + 1, target.id));
            await writePlanContent(doc.uri, (0, model_1.serializePlanMarkdown)(parsed.tasks));
        }
        const latestDoc = await vscode.workspace.openTextDocument(doc.uri);
        await refreshFromDocument(latestDoc);
        vscode.window.showInformationMessage(`Planned ${target.id} with one-level expansion.`);
    });
}
async function handleAddTask(arg) {
    const taskRef = extractTaskCommandRef(arg);
    const doc = await resolvePlanDocumentForCommand(taskRef);
    const parsed = (0, model_1.parsePlanMarkdown)(doc.getText());
    const activeEditor = vscode.window.activeTextEditor;
    const taskId = taskRef.taskId;
    const parent = taskId
        ? (0, model_1.findTaskById)(parsed.tasks, taskId)
        : activeEditor && isPlanDocument(activeEditor.document)
            ? (0, model_1.findTaskByLine)(parsed.tasks, activeEditor.selection.active.line)
            : undefined;
    const input = await vscode.window.showInputBox({
        prompt: parent ? `Add child task under ${parent.id}` : "Add top-level task",
        placeHolder: "Describe the task to add"
    });
    const title = input?.trim();
    if (!title) {
        return;
    }
    if (parent) {
        const nextId = (0, model_1.createTaskIdGenerator)(parsed.tasks);
        parent.children.push((0, model_1.makeTaskNode)(nextId(), title, parent.depth + 1, parent.id));
    }
    else if (isOnlyBootstrapPlaceholder(parsed.tasks)) {
        parsed.tasks[0].title = title;
        parsed.tasks[0].status = " ";
    }
    else {
        const nextId = (0, model_1.createTaskIdGenerator)(parsed.tasks);
        parsed.tasks.push((0, model_1.makeTaskNode)(nextId(), title, 0, null));
    }
    await writePlanContent(doc.uri, (0, model_1.serializePlanMarkdown)(parsed.tasks));
    const latest = await vscode.workspace.openTextDocument(doc.uri);
    await refreshFromDocument(latest);
    vscode.window.showInformationMessage(`Added task: ${title}`);
}
async function handleDrillDown(arg) {
    const taskRef = extractTaskCommandRef(arg);
    const doc = await resolvePlanDocumentForCommand(taskRef);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    const parsed = (0, model_1.parsePlanMarkdown)(doc.getText());
    const taskId = taskRef.taskId;
    const target = taskId ? (0, model_1.findTaskById)(parsed.tasks, taskId) : (0, model_1.findTaskByLine)(parsed.tasks, editor.selection.active.line);
    if (!target) {
        vscode.window.showErrorMessage("No task found to drill down.");
        return;
    }
    const line = Math.max(target.line, 0);
    const position = new vscode.Position(line, 0);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
}
async function handleImplementTask(arg) {
    const taskRef = extractTaskCommandRef(arg);
    const doc = await resolvePlanDocumentForCommand(taskRef);
    const parsed = (0, model_1.parsePlanMarkdown)(doc.getText());
    const activeEditor = vscode.window.activeTextEditor;
    const taskId = taskRef.taskId;
    const target = taskId
        ? (0, model_1.findTaskById)(parsed.tasks, taskId)
        : activeEditor && isPlanDocument(activeEditor.document)
            ? (0, model_1.findTaskByLine)(parsed.tasks, activeEditor.selection.active.line)
            : undefined;
    if (!target) {
        vscode.window.showErrorMessage("No task found to implement.");
        return;
    }
    await vscode.window.withProgress({
        title: `Implementing ${target.id}`,
        location: vscode.ProgressLocation.Notification,
        cancellable: true
    }, async (progress, token) => {
        const ancestors = (0, model_1.collectAncestorChain)(parsed.tasks, target.id);
        const relatedFiles = await collectRelevantFiles(target.title, 20);
        const snapshots = await collectRelevantFileSnapshots(relatedFiles, MAX_IMPLEMENTATION_SNAPSHOTS, MAX_IMPLEMENTATION_FILE_CHARS, MAX_IMPLEMENTATION_TOTAL_CHARS);
        const prompt = buildImplementPrompt(target, ancestors, relatedFiles, snapshots);
        const safePrompt = (0, lm_1.maskSensitiveText)(prompt);
        let modelOutput = "";
        progress.report({ message: "Requesting implementation edits from Copilot..." });
        await (0, lm_1.streamCopilotText)(safePrompt, async (chunk) => {
            if (token.isCancellationRequested) {
                return;
            }
            modelOutput += chunk;
        }, token);
        progress.report({ message: "Applying generated file changes..." });
        const payload = await parseImplementationWithRepair(modelOutput, token);
        const writtenFiles = await applyImplementationChanges(payload);
        // Implement command represents completion for the selected feature scope.
        markTaskSubtreeStatus(target, "x");
        await writePlanContent(doc.uri, (0, model_1.serializePlanMarkdown)(parsed.tasks));
        const refreshedDoc = await vscode.workspace.openTextDocument(doc.uri);
        await refreshFromDocument(refreshedDoc);
        if (writtenFiles.length > 0) {
            const first = vscode.Uri.joinPath(getWorkspaceRootUri(), ...writtenFiles[0].split("/"));
            const firstDoc = await vscode.workspace.openTextDocument(first);
            await vscode.window.showTextDocument(firstDoc, { preview: false });
        }
        const summarySuffix = payload.summary ? ` ${payload.summary}` : "";
        vscode.window.showInformationMessage(`Implemented ${target.id}: wrote ${writtenFiles.length} file(s).${summarySuffix}`);
    });
}
async function handleDeleteTask(arg) {
    const taskRef = extractTaskCommandRef(arg);
    const doc = await resolvePlanDocumentForCommand(taskRef);
    const parsed = (0, model_1.parsePlanMarkdown)(doc.getText());
    const activeEditor = vscode.window.activeTextEditor;
    const taskId = taskRef.taskId;
    const target = taskId
        ? (0, model_1.findTaskById)(parsed.tasks, taskId)
        : activeEditor && isPlanDocument(activeEditor.document)
            ? (0, model_1.findTaskByLine)(parsed.tasks, activeEditor.selection.active.line)
            : undefined;
    if (!target) {
        vscode.window.showErrorMessage("No task found to delete.");
        return;
    }
    const decision = await vscode.window.showWarningMessage(`Delete task ${target.id} and all of its sub-tasks?`, { modal: true }, "Delete");
    if (decision !== "Delete") {
        return;
    }
    const removed = deleteTaskById(parsed.tasks, target.id);
    if (!removed) {
        vscode.window.showErrorMessage(`Unable to delete task ${target.id}.`);
        return;
    }
    await writePlanContent(doc.uri, (0, model_1.serializePlanMarkdown)(parsed.tasks));
    const latest = await vscode.workspace.openTextDocument(doc.uri);
    await refreshFromDocument(latest);
    vscode.window.showInformationMessage(`Deleted task ${target.id}.`);
}
async function syncExecutionQueue(document) {
    const parsed = (0, model_1.parsePlanMarkdown)(document.getText());
    if (parsed.planHeadingLine < 0) {
        return;
    }
    const next = (0, model_1.serializePlanMarkdown)(parsed.tasks);
    if (next !== document.getText()) {
        await writePlanContent(document.uri, next);
    }
}
async function refreshFromDocument(document) {
    const parsed = (0, model_1.parsePlanMarkdown)(document.getText());
    activePlanUri = document.uri;
    treeProvider.setTasks(parsed.tasks, document.uri);
    updateVisiblePlanDecorations();
}
function updateVisiblePlanDecorations() {
    for (const editor of vscode.window.visibleTextEditors) {
        if (!isPlanDocument(editor.document)) {
            continue;
        }
        const parsed = (0, model_1.parsePlanMarkdown)(editor.document.getText());
        const planLines = [];
        const executeLines = [];
        const leaves = new Set((0, model_1.listLeafTasks)(parsed.tasks).map((task) => task.id));
        walk(parsed.tasks, (task) => {
            if (task.line < 0 || task.line >= editor.document.lineCount) {
                return;
            }
            const range = new vscode.Range(task.line, 0, task.line, 0);
            if (leaves.has(task.id)) {
                executeLines.push({ range });
            }
            else {
                planLines.push({ range });
            }
        });
        editor.setDecorations(planDecorationType, planLines);
        editor.setDecorations(executeDecorationType, executeLines);
    }
}
async function ensurePlanDocument(preferredUri) {
    if (preferredUri && isSupportedPlanUri(preferredUri)) {
        if (!(await uriExists(preferredUri))) {
            await vscode.workspace.fs.writeFile(preferredUri, Buffer.from((0, model_1.serializePlanMarkdown)([]), "utf8"));
        }
        return vscode.workspace.openTextDocument(preferredUri);
    }
    const existing = await findExistingPlanDocument();
    if (existing) {
        return existing;
    }
    const root = getWorkspaceRootUri();
    const uri = vscode.Uri.joinPath(root, DEFAULT_PLAN_FILENAME);
    await vscode.workspace.fs.writeFile(uri, Buffer.from((0, model_1.serializePlanMarkdown)([]), "utf8"));
    return vscode.workspace.openTextDocument(uri);
}
async function resolvePlanDocumentForCommand(taskRef) {
    const taskId = taskRef?.taskId;
    const candidates = [];
    const pushCandidate = (uri) => {
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
        const parsed = (0, model_1.parsePlanMarkdown)(doc.getText());
        if ((0, model_1.findTaskById)(parsed.tasks, taskId)) {
            return doc;
        }
    }
    return ensurePlanDocument(taskRef?.fileUri);
}
async function findExistingPlanDocument() {
    const uris = await findExistingPlanUris();
    if (uris.length === 0) {
        return undefined;
    }
    return vscode.workspace.openTextDocument(uris[0]);
}
async function findExistingPlanUris() {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) {
        return [];
    }
    const result = [];
    for (const name of PLAN_FILENAMES) {
        const uri = vscode.Uri.joinPath(root, name);
        if (await uriExists(uri)) {
            result.push(uri);
        }
    }
    return result;
}
function getWorkspaceRootUri() {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) {
        throw new Error("Open a workspace folder to use PlanMyProject.");
    }
    return root;
}
async function writePlanContent(uri, text) {
    internalWriteDepth += 1;
    try {
        const document = await vscode.workspace.openTextDocument(uri);
        if (document.getText() === text) {
            return;
        }
        const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
        const edit = new vscode.WorkspaceEdit();
        edit.replace(uri, fullRange, text);
        await vscode.workspace.applyEdit(edit);
        const latest = await vscode.workspace.openTextDocument(uri);
        await latest.save();
    }
    finally {
        internalWriteDepth -= 1;
    }
}
function isPlanDocument(document) {
    return isSupportedPlanUri(document.uri);
}
function isSupportedPlanUri(uri) {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root || uri.scheme !== "file") {
        return false;
    }
    const name = path.basename(uri.fsPath).toLowerCase();
    if (!PLAN_FILENAMES.includes(name)) {
        return false;
    }
    return path.resolve(path.dirname(uri.fsPath)) === path.resolve(root.fsPath);
}
function extractTaskCommandRef(arg) {
    const ref = {};
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
        const value = arg;
        if (typeof value.taskId === "string") {
            ref.taskId = value.taskId;
        }
        else if (typeof value.id === "string") {
            ref.taskId = value.id;
        }
        else if (typeof value.label === "string") {
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
function toUri(candidate) {
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
        }
        catch {
            return undefined;
        }
    }
    if (path.isAbsolute(trimmed)) {
        return vscode.Uri.file(trimmed);
    }
    return undefined;
}
async function uriExists(uri) {
    try {
        await vscode.workspace.fs.stat(uri);
        return true;
    }
    catch {
        return false;
    }
}
async function collectRelevantFiles(taskTitle, maxResults) {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) {
        return [];
    }
    const files = await vscode.workspace.findFiles("**/*", "{**/.git/**,**/node_modules/**,**/dist/**,**/out/**,**/build/**,**/.next/**}", 350);
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
async function collectRelevantFileSnapshots(filePaths, maxFiles, perFileLimit, totalLimit) {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) {
        return [];
    }
    const snapshots = [];
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
        }
        catch {
            // Skip unreadable files and continue collecting context.
        }
    }
    return snapshots;
}
async function parseImplementationWithRepair(modelOutput, token) {
    try {
        return (0, implement_1.parseImplementationPayload)(modelOutput);
    }
    catch (firstError) {
        if (token.isCancellationRequested) {
            throw firstError;
        }
        const repairPrompt = buildImplementRepairPrompt(modelOutput);
        const safeRepairPrompt = (0, lm_1.maskSensitiveText)(repairPrompt);
        let repaired = "";
        await (0, lm_1.streamCopilotText)(safeRepairPrompt, async (chunk) => {
            if (token.isCancellationRequested) {
                return;
            }
            repaired += chunk;
        }, token);
        return (0, implement_1.parseImplementationPayload)(repaired);
    }
}
async function applyImplementationChanges(payload) {
    const root = getWorkspaceRootUri();
    const written = [];
    const finalByPath = new Map();
    for (const change of payload.changes) {
        finalByPath.set(change.path, change.content);
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
function buildPlanPrompt(target, ancestors, relatedFiles, existingChildren, mode) {
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
function buildImplementPrompt(target, ancestors, relatedFiles, snapshots) {
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
function buildImplementRepairPrompt(output) {
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
function markTaskSubtreeStatus(task, status) {
    task.status = status;
    for (const child of task.children) {
        markTaskSubtreeStatus(child, status);
    }
}
function isOnlyBootstrapPlaceholder(tasks) {
    return tasks.length === 1
        && tasks[0].id === "T0001"
        && tasks[0].title === BOOTSTRAP_TASK_TITLE
        && tasks[0].children.length === 0;
}
function deleteTaskById(tasks, taskId) {
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
function walk(tasks, visitor) {
    for (const task of tasks) {
        visitor(task);
        walk(task.children, visitor);
    }
}
class PlanCodeLensProvider {
    provideCodeLenses(document) {
        if (!isPlanDocument(document)) {
            return [];
        }
        const parsed = (0, model_1.parsePlanMarkdown)(document.getText());
        const codeLenses = [];
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
//# sourceMappingURL=extension.js.map