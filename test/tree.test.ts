import test from "node:test";
import assert from "node:assert/strict";
import { makeTaskNode } from "../src/model";
import { PlanTreeProvider, TaskTreeItem } from "../src/tree";

test("PlanTreeProvider decorates active task item with running status", () => {
  const provider = new PlanTreeProvider();
  const root = makeTaskNode("T0001", "Build authentication", 0, null);
  provider.setTasks([root]);

  const requestId = provider.beginTaskRequest("T0001", "Preparing request...");
  provider.updateTaskRequest(requestId, "Streaming plan...");

  const rootChildren = provider.getChildren();
  assert.ok(Array.isArray(rootChildren));
  assert.equal(rootChildren.length, 1);

  const activeItem = rootChildren[0];
  assert.equal(activeItem.label, "Build authentication");
  assert.match(String(activeItem.description), /T0001/);
  assert.match(String(activeItem.description), /Streaming plan/);
  assert.equal((activeItem.iconPath as { id?: string }).id, "loading~spin");
  assert.equal((activeItem.command as { command?: string }).command, "planmyproject.drillDown");
  assert.equal(activeItem.contextValue, "activeRequestTaskRunning");
  provider.dispose();
});

test("PlanTreeProvider restores normal task context after request clears", () => {
  const provider = new PlanTreeProvider();
  const root = makeTaskNode("T0001", "Build authentication", 0, null);
  provider.setTasks([root]);

  const requestId = provider.beginTaskRequest("T0001", "Preparing request...");
  provider.finishTaskRequest(requestId, "success", "Done.", 500);

  const whileStatusActive = provider.getChildren();
  assert.ok(Array.isArray(whileStatusActive));
  assert.equal(whileStatusActive.length, 1);
  const requestItem = whileStatusActive[0];
  assert.equal((requestItem.iconPath as { id?: string }).id, "check");
  assert.equal(requestItem.contextValue, "leafTask");

  provider.clearTaskRequest(requestId);
  const afterClear = provider.getChildren();
  assert.ok(Array.isArray(afterClear));
  assert.equal(afterClear.length, 1);
  const normalItem = afterClear[0];
  assert.equal((normalItem.iconPath as { id?: string }).id, "circle-large-outline");
  assert.equal(normalItem.contextValue, "leafTask");
  provider.dispose();
});

test("TaskTreeItem navigation metadata is assigned for drill-down", () => {
  const task = makeTaskNode("T0007", "Implement endpoint", 0, null);
  const item = new TaskTreeItem(task);

  assert.equal(item.id, "T0007");
  assert.equal(item.description, "T0007");
  assert.equal((item.command as { command?: string }).command, "planmyproject.drillDown");
});
