import * as vscode from "vscode";
import { maskSensitiveText } from "./privacy";

export { maskSensitiveText };

export async function streamCopilotText(
  prompt: string,
  onChunk: (chunk: string) => Promise<void> | void,
  token?: vscode.CancellationToken
): Promise<string> {
  const model = await selectCopilotModel();
  const vsAny = vscode as unknown as {
    LanguageModelChatMessage?: { User: (text: string) => unknown };
  };

  const userMessage = vsAny.LanguageModelChatMessage?.User
    ? vsAny.LanguageModelChatMessage.User(prompt)
    : ({ role: "user", content: prompt } as unknown);

  const response = await model.sendRequest([userMessage], {}, token);
  let fullText = "";

  for await (const fragment of response.text) {
    const chunk = typeof fragment === "string" ? fragment : String(fragment);
    fullText += chunk;
    await onChunk(chunk);
  }

  return fullText;
}

async function selectCopilotModel(): Promise<any> {
  const lmAny = (vscode as unknown as { lm?: { selectChatModels?: (selector: unknown) => Promise<any[]> } }).lm;

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
