import * as path from "path";

export interface ImplementationChange {
  path: string;
  content: string;
}

export interface ImplementationPayload {
  summary: string;
  taskCompleted: boolean;
  changes: ImplementationChange[];
  tests: string[];
  risks: string[];
}

const SENSITIVE_BASENAMES = new Set([
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "npm-shrinkwrap.json",
  ".gitignore",
  ".gitattributes",
  ".editorconfig",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml"
]);

export function parseImplementationPayload(text: string): ImplementationPayload {
  const rawJson = extractJsonObject(text);
  if (!rawJson) {
    throw new Error("Copilot did not return a JSON object.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error("Copilot returned invalid JSON.");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Implementation response must be a JSON object.");
  }

  const obj = parsed as Record<string, unknown>;
  const changesRaw = Array.isArray(obj.changes) ? obj.changes : [];
  const changes: ImplementationChange[] = [];

  for (const entry of changesRaw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const item = entry as Record<string, unknown>;
    const pathValue = typeof item.path === "string" ? item.path : "";
    const contentValue = typeof item.content === "string" ? item.content : "";
    const normalizedPath = normalizeWorkspaceRelativePath(pathValue);
    if (!normalizedPath || !contentValue.trim()) {
      continue;
    }
    changes.push({
      path: normalizedPath,
      content: contentValue.replace(/\r\n/g, "\n")
    });
  }

  if (changes.length === 0) {
    throw new Error("No valid file changes were found in Copilot output.");
  }

  return {
    summary: typeof obj.summary === "string" ? obj.summary.trim() : "",
    taskCompleted: typeof obj.taskCompleted === "boolean" ? obj.taskCompleted : false,
    changes,
    tests: toStringList(obj.tests),
    risks: toStringList(obj.risks)
  };
}

export function normalizeWorkspaceRelativePath(input: string): string | undefined {
  if (!input) {
    return undefined;
  }

  const trimmed = input.trim();
  if (!trimmed) {
    return undefined;
  }

  if (trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.includes("://")) {
    return undefined;
  }

  const unixLike = trimmed.replace(/\\/g, "/").replace(/^\.?\//, "");
  if (!unixLike || unixLike.includes("\0") || path.posix.isAbsolute(unixLike)) {
    return undefined;
  }

  const normalized = path.posix.normalize(unixLike);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    return undefined;
  }

  return normalized;
}

export function isSensitiveWorkspacePath(input: string): boolean {
  const normalized = normalizeWorkspaceRelativePath(input);
  if (!normalized) {
    return false;
  }

  const lower = normalized.toLowerCase();
  if (
    lower.startsWith(".git/")
    || lower.startsWith(".vscode/")
    || lower.startsWith(".github/")
    || lower.startsWith(".devcontainer/")
  ) {
    return true;
  }

  const basename = path.posix.basename(lower);
  if (basename.startsWith(".env")) {
    return true;
  }
  if (SENSITIVE_BASENAMES.has(basename)) {
    return true;
  }
  if (basename === "jsconfig.json") {
    return true;
  }
  if (/^tsconfig(?:\..+)?\.json$/.test(basename)) {
    return true;
  }
  if (/^\.?eslintrc(?:\..+)?$/.test(basename) || /^eslint\.config\..+$/.test(basename)) {
    return true;
  }
  if (/^\.?prettierrc(?:\..+)?$/.test(basename) || /^prettier\.config\..+$/.test(basename)) {
    return true;
  }

  return false;
}

function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function extractJsonObject(text: string): string | undefined {
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null = fenceRegex.exec(text);
  while (match) {
    const candidate = findFirstJsonObject(match[1]);
    if (candidate) {
      return candidate;
    }
    match = fenceRegex.exec(text);
  }

  return findFirstJsonObject(text);
}

function findFirstJsonObject(text: string): string | undefined {
  const source = text.trim();
  if (!source) {
    return undefined;
  }

  for (let start = source.indexOf("{"); start >= 0; start = source.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < source.length; i += 1) {
      const ch = source[i];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === "\"") {
          inString = false;
        }
        continue;
      }

      if (ch === "\"") {
        inString = true;
        continue;
      }
      if (ch === "{") {
        depth += 1;
        continue;
      }
      if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          const candidate = source.slice(start, i + 1);
          try {
            JSON.parse(candidate);
            return candidate;
          } catch {
            break;
          }
        }
      }
    }
  }

  return undefined;
}
