import { promises as fs } from "fs";
import * as path from "path";
import * as vscode from "vscode";

const FILE_SEARCH_EXCLUDE_GLOB = "{**/.git/**,**/node_modules/**,**/dist/**,**/out/**,**/build/**,**/.next/**}";
const FILE_SEARCH_LIMIT = 350;
const SKIPPED_SNAPSHOT_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".svg"]);

export interface FileSnapshot {
  path: string;
  content: string;
  truncated: boolean;
}

export async function uriExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

export async function collectRelevantFiles(taskTitle: string, maxResults: number): Promise<string[]> {
  const workspace = vscode.workspace.workspaceFolders?.[0];
  if (!workspace) {
    return [];
  }

  const files = await vscode.workspace.findFiles("**/*", FILE_SEARCH_EXCLUDE_GLOB, FILE_SEARCH_LIMIT);
  const tokens = taskTitle
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4);

  const relativePaths = files.map((uri) => vscode.workspace.asRelativePath(uri, false));
  if (tokens.length === 0) {
    return relativePaths.slice(0, maxResults);
  }

  const filtered = relativePaths.filter((filePath) => tokens.some((token) => filePath.toLowerCase().includes(token)));
  const selected = filtered.length > 0 ? filtered : relativePaths;
  return selected.slice(0, maxResults);
}

export async function collectRelevantFileSnapshots(
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
    if (!relativePath || SKIPPED_SNAPSHOT_EXTENSIONS.has(path.posix.extname(relativePath).toLowerCase())) {
      continue;
    }

    try {
      const uri = vscode.Uri.joinPath(root, ...relativePath.split("/"));
      const bytes = await vscode.workspace.fs.readFile(uri);
      const content = Buffer.from(bytes).toString("utf8");
      if (content.includes("\u0000")) {
        continue;
      }

      const remaining = totalLimit - totalChars;
      if (remaining <= 0) {
        break;
      }

      const allowed = Math.min(perFileLimit, remaining);
      const trimmed = content.slice(0, allowed);
      snapshots.push({
        path: relativePath,
        content: trimmed,
        truncated: content.length > allowed
      });
      totalChars += trimmed.length;
    } catch {
      // Skip unreadable files and continue collecting context.
    }
  }

  return snapshots;
}

export async function resolveWorkspaceWriteTargetUri(root: vscode.Uri, relativePath: string): Promise<vscode.Uri> {
  const rootFsPath = path.resolve(root.fsPath);
  const targetFsPath = path.resolve(rootFsPath, ...relativePath.split("/"));
  if (!isPathWithin(rootFsPath, targetFsPath)) {
    throw new Error(`Refusing to write outside workspace root: ${relativePath}`);
  }

  const canonicalRoot = await resolveCanonicalPath(rootFsPath);
  const ancestorRealPath = await findNearestExistingAncestorRealPath(targetFsPath, rootFsPath);
  if (ancestorRealPath && !isPathWithin(canonicalRoot, ancestorRealPath)) {
    throw new Error(`Refusing to write through symlink outside workspace root: ${relativePath}`);
  }

  return vscode.Uri.file(targetFsPath);
}

async function resolveCanonicalPath(fsPath: string): Promise<string> {
  try {
    return await fs.realpath(fsPath);
  } catch {
    return path.resolve(fsPath);
  }
}

async function findNearestExistingAncestorRealPath(
  targetFsPath: string,
  rootFsPath: string
): Promise<string | undefined> {
  let current = targetFsPath;
  while (isPathWithin(rootFsPath, current)) {
    try {
      return await fs.realpath(current);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return undefined;
      }
      current = parent;
    }
  }

  return undefined;
}

function isPathWithin(parentPath: string, childPath: string): boolean {
  const parent = normalizePathForComparison(parentPath);
  const child = normalizePathForComparison(childPath);
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizePathForComparison(fsPath: string): string {
  const resolved = path.resolve(fsPath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
