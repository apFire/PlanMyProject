import * as vscode from "vscode";
import { TaskNode } from "./model";

type RequestState = "running" | "success" | "error" | "cancelled";

interface RequestStatus {
  requestId: number;
  title: string;
  detail: string;
  state: RequestState;
}

type PlanTreeElement = TaskTreeItem | RequestStatusTreeItem;

export class PlanTreeProvider implements vscode.TreeDataProvider<PlanTreeElement>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<PlanTreeElement | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  private roots: TaskNode[] = [];
  private sourceUri?: vscode.Uri;
  private requestStatus?: RequestStatus;
  private nextRequestId = 0;
  private clearTimer: ReturnType<typeof setTimeout> | undefined;

  setTasks(tasks: TaskNode[], sourceUri?: vscode.Uri): void {
    this.roots = tasks;
    this.sourceUri = sourceUri;
    this.refresh();
  }

  beginRequest(title: string, detail: string): number {
    this.clearScheduledRequestClear();
    const requestId = ++this.nextRequestId;
    this.requestStatus = { requestId, title, detail, state: "running" };
    this.refresh();
    return requestId;
  }

  updateRequest(requestId: number, detail: string): void {
    if (!this.requestStatus || this.requestStatus.requestId !== requestId) {
      return;
    }
    if (this.requestStatus.detail === detail) {
      return;
    }
    this.requestStatus = { ...this.requestStatus, detail };
    this.refresh();
  }

  finishRequest(requestId: number, state: Exclude<RequestState, "running">, detail: string, clearAfterMs = 0): void {
    if (!this.requestStatus || this.requestStatus.requestId !== requestId) {
      return;
    }
    this.requestStatus = { ...this.requestStatus, state, detail };
    this.refresh();
    this.clearRequest(requestId, clearAfterMs);
  }

  clearRequest(requestId?: number, delayMs = 0): void {
    if (delayMs > 0) {
      this.clearScheduledRequestClear();
      this.clearTimer = setTimeout(() => {
        this.clearRequest(requestId, 0);
      }, delayMs);
      return;
    }

    if (!this.requestStatus) {
      return;
    }
    if (typeof requestId === "number" && this.requestStatus.requestId !== requestId) {
      return;
    }
    this.requestStatus = undefined;
    this.refresh();
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(element: PlanTreeElement): vscode.TreeItem {
    return element;
  }

  getChildren(element?: PlanTreeElement): vscode.ProviderResult<PlanTreeElement[]> {
    if (element instanceof TaskTreeItem) {
      return element.task.children.map((task) => new TaskTreeItem(task, this.sourceUri));
    }
    if (element instanceof RequestStatusTreeItem) {
      return [];
    }

    const taskItems = this.roots.map((task) => new TaskTreeItem(task, this.sourceUri));
    if (!this.requestStatus) {
      return taskItems;
    }
    return [new RequestStatusTreeItem(this.requestStatus), ...taskItems];
  }

  dispose(): void {
    this.clearScheduledRequestClear();
    this.emitter.dispose();
  }

  private clearScheduledRequestClear(): void {
    if (!this.clearTimer) {
      return;
    }
    clearTimeout(this.clearTimer);
    this.clearTimer = undefined;
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

class RequestStatusTreeItem extends vscode.TreeItem {
  constructor(status: RequestStatus) {
    super(status.title, vscode.TreeItemCollapsibleState.None);
    this.id = `planmyproject.request.${status.requestId}`;
    this.contextValue = "requestStatus";
    this.description = summarizeStatusDetail(status.detail);
    this.tooltip = `${status.title}\n${status.detail}`;
    this.iconPath = iconForRequestState(status.state);
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

function summarizeStatusDetail(detail: string): string {
  const compact = detail.replace(/\s+/g, " ").trim();
  const maxLen = 52;
  if (compact.length <= maxLen) {
    return compact;
  }

  return `${compact.slice(0, maxLen).trimEnd()}…`;
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

function iconForRequestState(state: RequestState): vscode.ThemeIcon {
  if (state === "running") {
    return new vscode.ThemeIcon("loading~spin");
  }
  if (state === "success") {
    return new vscode.ThemeIcon("check");
  }
  if (state === "cancelled") {
    return new vscode.ThemeIcon("circle-slash");
  }
  return new vscode.ThemeIcon("error");
}
