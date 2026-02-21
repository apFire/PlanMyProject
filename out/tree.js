"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.TaskTreeItem = exports.PlanTreeProvider = void 0;
const vscode = __importStar(require("vscode"));
class PlanTreeProvider {
    emitter = new vscode.EventEmitter();
    onDidChangeTreeData = this.emitter.event;
    roots = [];
    sourceUri;
    setTasks(tasks, sourceUri) {
        this.roots = tasks;
        this.sourceUri = sourceUri;
        this.refresh();
    }
    refresh() {
        this.emitter.fire(undefined);
    }
    getTreeItem(element) {
        return element;
    }
    getChildren(element) {
        const source = element ? element.task.children : this.roots;
        return source.map((task) => new TaskTreeItem(task, this.sourceUri));
    }
}
exports.PlanTreeProvider = PlanTreeProvider;
class TaskTreeItem extends vscode.TreeItem {
    task;
    constructor(task, sourceUri) {
        super(summarizeTitle(task.title), task.children.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        this.task = task;
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
exports.TaskTreeItem = TaskTreeItem;
function summarizeTitle(title) {
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
function iconForStatus(status) {
    if (status === "x") {
        return new vscode.ThemeIcon("check");
    }
    if (status === "/") {
        return new vscode.ThemeIcon("dash");
    }
    return new vscode.ThemeIcon("circle-large-outline");
}
//# sourceMappingURL=tree.js.map