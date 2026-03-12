import * as vscode from "vscode";
import { TaskNode } from "./model";

type RequestState = "running" | "success" | "error" | "cancelled";

interface TaskRequestStatus {
  requestId: number;
  taskId: string;
  detail: string;
  state: RequestState;
}

export class PlanTreeProvider implements vscode.TreeDataProvider<TaskTreeItem>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<TaskTreeItem | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  private roots: TaskNode[] = [];
  private sourceUri?: vscode.Uri;
  private requestStatus?: TaskRequestStatus;
  private nextRequestId = 0;
  private clearTimer: ReturnType<typeof setTimeout> | undefined;

  setTasks(tasks: TaskNode[], sourceUri?: vscode.Uri): void {
    this.roots = tasks;
    this.sourceUri = sourceUri;
    this.refresh();
  }

  beginTaskRequest(taskId: string, detail: string): number {
    this.clearScheduledRequestClear();
    const requestId = ++this.nextRequestId;
    this.requestStatus = { requestId, taskId, detail, state: "running" };
    this.refresh();
    return requestId;
  }

  updateTaskRequest(requestId: number, detail: string): void {
    if (!this.requestStatus || this.requestStatus.requestId !== requestId) {
      return;
    }
    if (this.requestStatus.detail === detail) {
      return;
    }
    this.requestStatus = { ...this.requestStatus, detail };
    this.refresh();
  }

  finishTaskRequest(requestId: number, state: Exclude<RequestState, "running">, detail: string, clearAfterMs = 0): void {
    if (!this.requestStatus || this.requestStatus.requestId !== requestId) {
      return;
    }
    this.requestStatus = { ...this.requestStatus, state, detail };
    this.refresh();
    this.clearTaskRequest(requestId, clearAfterMs);
  }

  clearTaskRequest(requestId?: number, delayMs = 0): void {
    if (delayMs > 0) {
      this.clearScheduledRequestClear();
      this.clearTimer = setTimeout(() => {
        this.clearTaskRequest(requestId, 0);
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

  getTreeItem(element: TaskTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TaskTreeItem): vscode.ProviderResult<TaskTreeItem[]> {
    const source = element ? element.task.children : this.roots;
    return source.map((task) => this.makeTaskItem(task));
  }

  private makeTaskItem(task: TaskNode): TaskTreeItem {
    const taskRequest = this.requestStatus && this.requestStatus.taskId === task.id
      ? this.requestStatus
      : undefined;
    return new TaskTreeItem(task, this.sourceUri, taskRequest);
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
  constructor(readonly task: TaskNode, sourceUri?: vscode.Uri, request?: TaskRequestStatus) {
    super(summarizeTitle(task.title), task.children.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    this.id = task.id;
    this.description = request ? `${task.id} • ${summarizeStatusDetail(request.detail)}` : task.id;
    this.tooltip = request
      ? `${task.id} [${task.status}]\n${task.title}\n\n${request.detail}`
      : `${task.id} [${task.status}]\n${task.title}`;
    this.contextValue = request?.state === "running"
      ? "activeRequestTaskRunning"
      : task.children.length === 0
        ? "leafTask"
        : "taskNode";
    this.command = {
      command: "planmyproject.drillDown",
      title: "Drill Down",
      arguments: [{ taskId: task.id, fileUri: sourceUri?.toString() }]
    };
    if (sourceUri) {
      this.resourceUri = sourceUri;
    }
    this.iconPath = request ? iconForRequestState(request.state) : iconForStatus(task.status);
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
