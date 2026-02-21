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
exports.parseImplementationPayload = parseImplementationPayload;
exports.normalizeWorkspaceRelativePath = normalizeWorkspaceRelativePath;
const path = __importStar(require("path"));
function parseImplementationPayload(text) {
    const rawJson = extractJsonObject(text);
    if (!rawJson) {
        throw new Error("Copilot did not return a JSON object.");
    }
    let parsed;
    try {
        parsed = JSON.parse(rawJson);
    }
    catch {
        throw new Error("Copilot returned invalid JSON.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Implementation response must be a JSON object.");
    }
    const obj = parsed;
    const changesRaw = Array.isArray(obj.changes) ? obj.changes : [];
    const changes = [];
    for (const entry of changesRaw) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            continue;
        }
        const item = entry;
        const pathValue = typeof item.path === "string" ? item.path : "";
        const contentValue = typeof item.content === "string" ? item.content : "";
        const normalizedPath = normalizeWorkspaceRelativePath(pathValue);
        if (!normalizedPath || !contentValue.trim()) {
            continue;
        }
        changes.push({
            path: normalizedPath,
            content: contentValue.replace(/\r\n/g, "\n")
        });
    }
    if (changes.length === 0) {
        throw new Error("No valid file changes were found in Copilot output.");
    }
    return {
        summary: typeof obj.summary === "string" ? obj.summary.trim() : "",
        taskCompleted: typeof obj.taskCompleted === "boolean" ? obj.taskCompleted : false,
        changes,
        tests: toStringList(obj.tests),
        risks: toStringList(obj.risks)
    };
}
function normalizeWorkspaceRelativePath(input) {
    if (!input) {
        return undefined;
    }
    const trimmed = input.trim();
    if (!trimmed) {
        return undefined;
    }
    if (trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.includes("://")) {
        return undefined;
    }
    const unixLike = trimmed.replace(/\\/g, "/").replace(/^\.?\//, "");
    if (!unixLike || unixLike.includes("\0") || path.posix.isAbsolute(unixLike)) {
        return undefined;
    }
    const normalized = path.posix.normalize(unixLike);
    if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
        return undefined;
    }
    return normalized;
}
function toStringList(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value
        .filter((item) => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
}
function extractJsonObject(text) {
    const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
    let match = fenceRegex.exec(text);
    while (match) {
        const candidate = findFirstJsonObject(match[1]);
        if (candidate) {
            return candidate;
        }
        match = fenceRegex.exec(text);
    }
    return findFirstJsonObject(text);
}
function findFirstJsonObject(text) {
    const source = text.trim();
    if (!source) {
        return undefined;
    }
    for (let start = source.indexOf("{"); start >= 0; start = source.indexOf("{", start + 1)) {
        let depth = 0;
        let inString = false;
        let escaped = false;
        for (let i = start; i < source.length; i += 1) {
            const ch = source[i];
            if (inString) {
                if (escaped) {
                    escaped = false;
                }
                else if (ch === "\\") {
                    escaped = true;
                }
                else if (ch === "\"") {
                    inString = false;
                }
                continue;
            }
            if (ch === "\"") {
                inString = true;
                continue;
            }
            if (ch === "{") {
                depth += 1;
                continue;
            }
            if (ch === "}") {
                depth -= 1;
                if (depth === 0) {
                    const candidate = source.slice(start, i + 1);
                    try {
                        JSON.parse(candidate);
                        return candidate;
                    }
                    catch {
                        break;
                    }
                }
            }
        }
    }
    return undefined;
}
//# sourceMappingURL=implement.js.map