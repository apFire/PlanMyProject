import * as path from "path";
import type { Uri } from "vscode";

const MAX_IMPORTED_ROOT_TASKS = 24;
const MIN_IMPORT_TASK_LENGTH = 8;
const MAX_IMPORT_TASK_LENGTH = 180;
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

export function extractRootTaskCandidates(markdown: string): string[] {
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

    if (/^#{1,6}\s+.+$/.test(trimmed)) {
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

export function hasImportableMarkdownRequirements(markdown: string): boolean {
  return extractRootTaskCandidates(markdown).length > 0;
}

export function hasExplicitRequirementList(markdown: string): boolean {
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

export function buildConsolidatedRequirementTitle(
  requirementFile: Pick<Uri, "fsPath">,
  candidates: string[]
): string {
  const stem = path.parse(requirementFile.fsPath).name.replace(/[_-]+/g, " ").trim();
  if (stem.length >= 3) {
    return `Implement requirements from ${stem}`;
  }
  return candidates[0];
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

  if (/^[A-Za-z][A-Za-z0-9 _-]{0,24}:\s+\S+/.test(compact)) {
    return undefined;
  }

  return compact;
}
