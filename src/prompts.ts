import type { TaskNode } from "./model";
import type { FileSnapshot } from "./workspace";

export function buildPlanPrompt(
  target: TaskNode,
  ancestors: TaskNode[],
  relatedFiles: string[],
  existingChildren: string[],
  mode: "replace" | "refine"
): string {
  const hierarchy = ancestors.map((node, index) => `${index + 1}. [${node.id}] ${node.title}`).join("\n");
  const childContext = existingChildren.length > 0
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

export function buildImplementPrompt(
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

export function buildImplementRepairPrompt(output: string, maxRepairInputChars: number): string {
  const trimmedOutput = output.slice(0, maxRepairInputChars);
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
