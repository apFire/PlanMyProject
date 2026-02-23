import test from "node:test";
import assert from "node:assert/strict";
import {
  isSensitiveWorkspacePath,
  normalizeWorkspaceRelativePath,
  parseImplementationPayload
} from "../src/implement";

test("parseImplementationPayload parses fenced JSON and normalizes paths", () => {
  const raw = [
    "Here are changes:",
    "```json",
    "{",
    "  \"summary\": \"Added task endpoint\",",
    "  \"taskCompleted\": true,",
    "  \"changes\": [",
    "    { \"path\": \"./src\\\\api\\\\task.ts\", \"content\": \"export const task = 1;\" }",
    "  ],",
    "  \"tests\": [\"npm test\"],",
    "  \"risks\": [\"None\"]",
    "}",
    "```"
  ].join("\n");

  const payload = parseImplementationPayload(raw);
  assert.equal(payload.summary, "Added task endpoint");
  assert.equal(payload.taskCompleted, true);
  assert.equal(payload.changes.length, 1);
  assert.equal(payload.changes[0].path, "src/api/task.ts");
  assert.equal(payload.tests[0], "npm test");
});

test("parseImplementationPayload throws when no valid changes exist", () => {
  const raw = JSON.stringify({
    summary: "No-op",
    taskCompleted: false,
    changes: [{ path: "../outside.ts", content: "x" }]
  });

  assert.throws(() => parseImplementationPayload(raw), /No valid file changes/);
});

test("normalizeWorkspaceRelativePath blocks absolute and traversal paths", () => {
  assert.equal(normalizeWorkspaceRelativePath("src/main.ts"), "src/main.ts");
  assert.equal(normalizeWorkspaceRelativePath("./src/main.ts"), "src/main.ts");
  assert.equal(normalizeWorkspaceRelativePath("../main.ts"), undefined);
  assert.equal(normalizeWorkspaceRelativePath("/etc/passwd"), undefined);
});

test("isSensitiveWorkspacePath flags sensitive paths and allows regular source files", () => {
  assert.equal(isSensitiveWorkspacePath("src/main.ts"), false);
  assert.equal(isSensitiveWorkspacePath("./src/main.ts"), false);
  assert.equal(isSensitiveWorkspacePath(".vscode/settings.json"), true);
  assert.equal(isSensitiveWorkspacePath(".github/workflows/ci.yml"), true);
  assert.equal(isSensitiveWorkspacePath("package.json"), true);
  assert.equal(isSensitiveWorkspacePath("tsconfig.json"), true);
  assert.equal(isSensitiveWorkspacePath("config/.env.local"), true);
});
