import test from "node:test";
import assert from "node:assert/strict";
import { makeTaskNode } from "../src/model";
import { PlanTreeProvider, TaskTreeItem } from "../src/tree";

test("PlanTreeProvider exposes running request status item before tasks", () => {
  const provider = new PlanTreeProvider();
  const root = makeTaskNode("T0001", "Build authentication", 0, null);
  provider.setTasks([root]);

  const requestId = provider.beginRequest("Planning T0001", "Preparing request...");
  provider.updateRequest(requestId, "Streaming plan...");

  const rootChildren = provider.getChildren();
  assert.ok(Array.isArray(rootChildren));
  assert.equal(rootChildren.length, 2);

  const statusItem = rootChildren[0] as Record<string, unknown>;
  assert.equal(statusItem.label, "Planning T0001");
  assert.equal(statusItem.description, "Streaming plan...");
  assert.equal((statusItem.iconPath as { id?: string }).id, "loading~spin");
  assert.equal((statusItem.command as { command?: string }).command, "planmyproject.cancelActiveRequest");
  assert.equal(statusItem.contextValue, "requestStatusRunning");
  provider.dispose();
});

test("PlanTreeProvider can finish and clear request status", () => {
  const provider = new PlanTreeProvider();
  const root = makeTaskNode("T0001", "Build authentication", 0, null);
  provider.setTasks([root]);

  const requestId = provider.beginRequest("Planning T0001", "Preparing request...");
  provider.finishRequest(requestId, "success", "Done.", 500);

  const withStatus = provider.getChildren();
  assert.ok(Array.isArray(withStatus));
  assert.equal(withStatus.length, 2);
  const statusItem = withStatus[0] as Record<string, unknown>;
  assert.equal((statusItem.iconPath as { id?: string }).id, "check");
  assert.equal(statusItem.contextValue, "requestStatus");

  provider.clearRequest(requestId);
  const afterClear = provider.getChildren();
  assert.ok(Array.isArray(afterClear));
  assert.equal(afterClear.length, 1);
  provider.dispose();
});

test("TaskTreeItem navigation metadata is assigned for drill-down", () => {
  const task = makeTaskNode("T0007", "Implement endpoint", 0, null);
  const item = new TaskTreeItem(task);

  assert.equal(item.id, "T0007");
  assert.equal(item.description, "T0007");
  assert.equal((item.command as { command?: string }).command, "planmyproject.drillDown");
});
