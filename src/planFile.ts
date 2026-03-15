import * as path from "path";
import * as vscode from "vscode";
import { findTaskById, parsePlanMarkdown, serializePlanMarkdown } from "./model";
import { uriExists } from "./workspace";

export const PLAN_FILENAMES = ["planmyproject.md", "projectplan.md"] as const;
export const ROOT_PLAN_GLOB = `{${PLAN_FILENAMES.join(",")}}`;
const DEFAULT_PLAN_FILENAME = PLAN_FILENAMES[0];

export interface TaskCommandRef {
  taskId?: string;
  fileUri?: vscode.Uri;
}

export function isPlanDocument(document: vscode.TextDocument): boolean {
  return isSupportedPlanUri(document.uri);
}

export function isSupportedPlanUri(uri: vscode.Uri): boolean {
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

export async function ensurePlanDocument(preferredUri?: vscode.Uri): Promise<vscode.TextDocument> {
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

export async function resolvePlanDocumentForCommand(
  taskRef?: TaskCommandRef,
  activePlanUri?: vscode.Uri
): Promise<vscode.TextDocument> {
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

export async function findExistingPlanDocument(): Promise<vscode.TextDocument | undefined> {
  const uris = await findExistingPlanUris();
  if (uris.length === 0) {
    return undefined;
  }
  return vscode.workspace.openTextDocument(uris[0]);
}

export async function findExistingPlanUris(): Promise<vscode.Uri[]> {
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

export function getWorkspaceRootUri(): vscode.Uri {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) {
    throw new Error("PlanMyProject requires an open folder or workspace.");
  }
  return root;
}

export function extractTaskCommandRef(arg?: unknown): TaskCommandRef {
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
