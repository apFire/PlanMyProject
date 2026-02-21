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
exports.maskSensitiveText = void 0;
exports.streamCopilotText = streamCopilotText;
const vscode = __importStar(require("vscode"));
const privacy_1 = require("./privacy");
Object.defineProperty(exports, "maskSensitiveText", { enumerable: true, get: function () { return privacy_1.maskSensitiveText; } });
async function streamCopilotText(prompt, onChunk, token) {
    const model = await selectCopilotModel();
    const vsAny = vscode;
    const userMessage = vsAny.LanguageModelChatMessage?.User
        ? vsAny.LanguageModelChatMessage.User(prompt)
        : { role: "user", content: prompt };
    const response = await model.sendRequest([userMessage], {}, token);
    let fullText = "";
    for await (const fragment of response.text) {
        const chunk = typeof fragment === "string" ? fragment : String(fragment);
        fullText += chunk;
        await onChunk(chunk);
    }
    return fullText;
}
async function selectCopilotModel() {
    const lmAny = vscode.lm;
    if (!lmAny?.selectChatModels) {
        throw new Error("VS Code LM API is unavailable in this environment.");
    }
    let models = await lmAny.selectChatModels({ vendor: "copilot" });
    if (!models || models.length === 0) {
        models = await lmAny.selectChatModels({});
    }
    if (!models || models.length === 0) {
        throw new Error("No Copilot chat model is available. Sign in to Copilot and retry.");
    }
    return models[0];
}
//# sourceMappingURL=lm.js.map