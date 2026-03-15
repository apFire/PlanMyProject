import test from "node:test";
import assert from "node:assert/strict";
import {
  buildConsolidatedRequirementTitle,
  extractRootTaskCandidates,
  hasExplicitRequirementList,
  hasImportableMarkdownRequirements
} from "../src/requirements";

test("extractRootTaskCandidates prefers actionable bullets and skips metadata", () => {
  const markdown = [
    "# Requirements",
    "",
    "Owner: Jane",
    "- Build authentication service",
    "- Build authentication service",
    "- Add session management",
    "",
    "```md",
    "- ignored code block entry",
    "```"
  ].join("\n");

  assert.deepEqual(extractRootTaskCandidates(markdown), [
    "Build authentication service",
    "Add session management"
  ]);
});

test("extractRootTaskCandidates can derive a task from prose paragraphs", () => {
  const markdown = [
    "The application should support multi-tenant project dashboards.",
    "",
    "Notes:"
  ].join("\n");

  assert.deepEqual(extractRootTaskCandidates(markdown), [
    "The application should support multi-tenant project dashboards"
  ]);
});

test("hasExplicitRequirementList detects markdown lists outside code fences", () => {
  const markdown = [
    "```",
    "- ignored list item",
    "```",
    "",
    "1. Create API routes"
  ].join("\n");

  assert.equal(hasExplicitRequirementList(markdown), true);
  assert.equal(hasImportableMarkdownRequirements(markdown), true);
});

test("buildConsolidatedRequirementTitle uses the file stem when available", () => {
  assert.equal(
    buildConsolidatedRequirementTitle({ fsPath: "/tmp/product_spec.md" }, ["Fallback task"]),
    "Implement requirements from product spec"
  );
});
