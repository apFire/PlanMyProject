import * as vscode from "vscode";
import { TaskNode } from "./model";

export class PlanTreeProvider implements vscode.TreeDataProvider<TaskTreeItem> {
  private readonly emitter = new vscode.EventEmitter<TaskTreeItem | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  private roots: TaskNode[] = [];
  private sourceUri?: vscode.Uri;

  setTasks(tasks: TaskNode[], sourceUri?: vscode.Uri): void {
    this.roots = tasks;
    this.sourceUri = sourceUri;
    this.refresh();
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(element: TaskTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TaskTreeItem): vscode.ProviderResult<TaskTreeItem[]> {
    const source = element ? element.task.children : this.roots;
    return source.map((task) => new TaskTreeItem(task, this.sourceUri));
  }
}

export class TaskTreeItem extends vscode.TreeItem {
  constructor(readonly task: TaskNode, sourceUri?: vscode.Uri) {
    super(summarizeTitle(task.title), task.children.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    this.id = task.id;
    this.description = task.id;
    this.tooltip = `${task.id} [${task.status}]\n${task.title}`;
    this.contextValue = task.children.length === 0 ? "leafTask" : "taskNode";
    this.command = {
      command: "planmyproject.drillDown",
      title: "Drill Down",
      arguments: [{ taskId: task.id, fileUri: sourceUri?.toString() }]
    };
    if (sourceUri) {
      this.resourceUri = sourceUri;
    }
    this.iconPath = iconForStatus(task.status);
  }
}

function summarizeTitle(title: string): string {
  const compact = title.replace(/\s+/g, " ").trim();
  const maxLen = 56;
  if (compact.length <= maxLen) {
    return compact;
  }

  const sliced = compact.slice(0, maxLen + 1);
  const wordBreak = sliced.lastIndexOf(" ");
  const end = wordBreak >= 32 ? wordBreak : maxLen;
  return `${compact.slice(0, end).trimEnd()}…`;
}

function iconForStatus(status: TaskNode["status"]): vscode.ThemeIcon {
  if (status === "x") {
    return new vscode.ThemeIcon("check");
  }
  if (status === "/") {
    return new vscode.ThemeIcon("dash");
  }
  return new vscode.ThemeIcon("circle-large-outline");
}
