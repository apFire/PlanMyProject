"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parsePlanMarkdown = parsePlanMarkdown;
exports.serializePlanMarkdown = serializePlanMarkdown;
exports.listLeafTasks = listLeafTasks;
exports.walkTasks = walkTasks;
exports.findTaskById = findTaskById;
exports.findTaskByLine = findTaskByLine;
exports.collectAncestorChain = collectAncestorChain;
exports.createTaskIdGenerator = createTaskIdGenerator;
exports.makeTaskNode = makeTaskNode;
exports.recomputeDerivedStatuses = recomputeDerivedStatuses;
exports.parseAiTaskTitles = parseAiTaskTitles;
const PLAN_TREE_HEADING_RE = /^##\s+Plan Tree\s*$/i;
const QUEUE_HEADING_RE = /^##\s+Execution Queue\b/i;
const TASK_LINE_RE = /^(\s*)- \[( |\/|x|X)\] \[([A-Za-z0-9_-]+)\] (.+?)\s*$/;
function parsePlanMarkdown(text) {
    const lines = text.split(/\r?\n/);
    const planHeadingLine = lines.findIndex((line) => PLAN_TREE_HEADING_RE.test(line.trim()));
    const queueHeadingLine = lines.findIndex((line) => QUEUE_HEADING_RE.test(line.trim()));
    if (planHeadingLine < 0) {
        return { tasks: [], planHeadingLine: -1, queueHeadingLine: queueHeadingLine };
    }
    const end = queueHeadingLine > planHeadingLine ? queueHeadingLine : lines.length;
    const tasks = [];
    const stack = [];
    for (let line = planHeadingLine + 1; line < end; line += 1) {
        const raw = lines[line];
        const match = TASK_LINE_RE.exec(raw);
        if (!match) {
            continue;
        }
        const indent = match[1].length;
        const depth = Math.floor(indent / 2);
        const node = {
            id: match[3],
            title: match[4].trim(),
            status: normalizeStatus(match[2]),
            depth,
            parentId: null,
            children: [],
            line
        };
        while (stack.length > depth) {
            stack.pop();
        }
        const parent = depth > 0 ? stack[depth - 1] : undefined;
        if (parent) {
            node.parentId = parent.id;
            parent.children.push(node);
        }
        else {
            tasks.push(node);
        }
        stack[depth] = node;
    }
    return { tasks, planHeadingLine, queueHeadingLine };
}
function serializePlanMarkdown(tasks) {
    recomputeDerivedStatuses(tasks);
    const lines = [];
    lines.push("# Project Plan");
    lines.push("");
    lines.push("<!-- pmp:schema=v1 -->");
    lines.push("");
    lines.push("## Plan Tree");
    if (tasks.length === 0) {
        lines.push("- [ ] [T0001] Add your first objective");
        lines.push("  <!-- pmp:id=T0001;parent=ROOT -->");
    }
    else {
        for (const task of tasks) {
            lines.push(...renderTask(task, 0, "ROOT"));
        }
    }
    lines.push("");
    lines.push("## Execution Queue (Auto-Generated, Leaf Tasks Only)");
    const leaves = listLeafTasks(tasks);
    if (leaves.length === 0) {
        lines.push("1. (no leaf tasks)");
    }
    else {
        for (let i = 0; i < leaves.length; i += 1) {
            lines.push(`${i + 1}. [${leaves[i].id}] ${leaves[i].title}`);
        }
    }
    return `${lines.join("\n")}\n`;
}
function normalizeStatus(raw) {
    if (raw === "X") {
        return "x";
    }
    return raw;
}
function renderTask(task, depth, parentId) {
    const indent = "  ".repeat(depth);
    const lines = [];
    lines.push(`${indent}- [${task.status}] [${task.id}] ${task.title}`);
    lines.push(`${indent}  <!-- pmp:id=${task.id};parent=${parentId} -->`);
    lines.push("");
    for (const child of task.children) {
        lines.push(...renderTask(child, depth + 1, task.id));
    }
    return lines;
}
function listLeafTasks(tasks) {
    const result = [];
    walkTasks(tasks, (task) => {
        if (task.children.length === 0) {
            result.push(task);
        }
    });
    return result;
}
function walkTasks(tasks, visitor) {
    for (const task of tasks) {
        visitor(task);
        walkTasks(task.children, visitor);
    }
}
function findTaskById(tasks, taskId) {
    let found;
    walkTasks(tasks, (task) => {
        if (!found && task.id === taskId) {
            found = task;
        }
    });
    return found;
}
function findTaskByLine(tasks, line) {
    let best;
    walkTasks(tasks, (task) => {
        if (task.line <= line) {
            if (!best || task.line > best.line) {
                best = task;
            }
        }
    });
    return best;
}
function collectAncestorChain(tasks, taskId) {
    const chain = [];
    const found = collectAncestorChainInner(tasks, taskId, chain);
    return found ? chain : [];
}
function collectAncestorChainInner(tasks, taskId, chain) {
    for (const task of tasks) {
        chain.push(task);
        if (task.id === taskId) {
            return true;
        }
        if (collectAncestorChainInner(task.children, taskId, chain)) {
            return true;
        }
        chain.pop();
    }
    return false;
}
function createTaskIdGenerator(tasks) {
    let maxId = 0;
    walkTasks(tasks, (task) => {
        const match = /^T(\d+)$/.exec(task.id);
        if (match) {
            const current = Number(match[1]);
            if (current > maxId) {
                maxId = current;
            }
        }
    });
    return () => {
        maxId += 1;
        return `T${String(maxId).padStart(4, "0")}`;
    };
}
function makeTaskNode(id, title, depth, parentId) {
    return {
        id,
        title: title.trim(),
        status: " ",
        depth,
        parentId,
        children: [],
        line: -1
    };
}
function recomputeDerivedStatuses(tasks) {
    for (const task of tasks) {
        recomputeTask(task);
    }
}
function recomputeTask(task) {
    if (task.children.length === 0) {
        return task.status;
    }
    const childStatuses = task.children.map((child) => recomputeTask(child));
    const allDone = childStatuses.every((status) => status === "x");
    const anyStarted = childStatuses.some((status) => status === "x" || status === "/");
    if (allDone) {
        task.status = "x";
    }
    else if (anyStarted) {
        task.status = "/";
    }
    else {
        task.status = " ";
    }
    return task.status;
}
function parseAiTaskTitles(aiText) {
    const stripped = aiText
        .split(/\r?\n/)
        .filter((line) => !line.trim().startsWith("```"))
        .join("\n");
    const lines = stripped.split(/\r?\n/);
    const titles = [];
    const seen = new Set();
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
            continue;
        }
        const bulletMatch = /^(?:[-*+]|(?:\d+[.)]))\s+(?:\[[ xX/]\]\s*)?(.+)$/.exec(trimmed);
        if (!bulletMatch) {
            continue;
        }
        const cleaned = bulletMatch[1]
            .trim()
            .replace(/^[\-\u2022]\s*/, "")
            .replace(/\s+/g, " ")
            .replace(/[.;:]+$/, "")
            .trim();
        if (!cleaned) {
            continue;
        }
        const key = cleaned.toLowerCase();
        if (!seen.has(key)) {
            seen.add(key);
            titles.push(cleaned);
        }
    }
    if (titles.length > 0) {
        return titles.slice(0, 8);
    }
    // Fallback: split short, line-based non-bullet responses.
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
            continue;
        }
        if (trimmed.length < 8 || trimmed.length > 140) {
            continue;
        }
        const key = trimmed.toLowerCase();
        if (!seen.has(key)) {
            seen.add(key);
            titles.push(trimmed.replace(/[.;:]+$/, ""));
        }
    }
    return titles.slice(0, 8);
}
//# sourceMappingURL=model.js.map