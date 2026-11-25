import Anthropic from "@anthropic-ai/sdk";
import { HttpError } from "../lib/http.js";
import { failed, post, refused, TIMEOUT_MS, type Ai, type Meter } from "./generate.js";

// A conversation where the AI may call tools (Ask Zenin, Change access with
// AI), the same way for Claude, Gemini and ChatGPT. The caller gives the
// tools and runs them; nothing here knows what they do.

/* ---------------- the three providers ---------------- */

export type ToolDef = { name: string; description: string; parameters: Record<string, unknown> };
export type ToolResult = { text: string; isError: boolean };
export type Turn = { role: "user" | "assistant"; content: string };
// one conversation: the instructions, the turns so far, the tools the AI may
// call, and what calling one does (its answer goes back to the AI)
export type Run = {
  system: string;
  turns: Turn[];
  ai: Ai;
  meter: Meter;
  tools: ToolDef[];
  runTool: (name: string, input: unknown) => Promise<ToolResult>;
  maxRounds?: number;
};

const outOfRounds = "I couldn't finish looking that up. Try a more specific question.";
const DEFAULT_ROUNDS = 6;

async function chatClaude({ system, turns, ai, meter, tools: TOOLS, runTool, maxRounds = DEFAULT_ROUNDS }: Run): Promise<string> {
  const client = new Anthropic({ apiKey: ai.key, authToken: null, timeout: TIMEOUT_MS });
  const tools: Anthropic.Beta.Messages.BetaTool[] = TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Anthropic.Beta.Messages.BetaTool.InputSchema,
  }));
  const messages: Anthropic.Beta.Messages.BetaMessageParam[] = turns.map((t) => ({ role: t.role, content: t.content }));
  try {
    for (let round = 0; round < maxRounds; round++) {
      const response = await client.beta.messages.create({
        model: ai.model,
        max_tokens: 16000,
        // a declined request is re-run on Anthropic's recommended fallback model
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        // a chat: quick answers; the instructions and tables are cached across rounds
        output_config: { effort: "low" },
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        tools,
        messages,
      });
      const u = response.usage;
      meter.cacheRead += u.cache_read_input_tokens ?? 0;
      meter.cacheWrite += u.cache_creation_input_tokens ?? 0;
      meter.input += u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      meter.output += u.output_tokens;

      if (response.stop_reason === "refusal") throw refused(ai);
      const uses = response.content.filter((b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === "tool_use");
      if (response.stop_reason !== "tool_use" || !uses.length) {
        if (response.stop_reason === "max_tokens") throw new HttpError(502, "The answer came back incomplete. Try a narrower question.");
        const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
        return text || outOfRounds;
      }
      // the whole answer goes back as it came (thinking included)
      messages.push({ role: "assistant", content: response.content });
      const results: Anthropic.Beta.Messages.BetaToolResultBlockParam[] = [];
      for (const use of uses) {
        const r = await runTool(use.name, use.input);
        results.push({ type: "tool_result", tool_use_id: use.id, content: r.text, is_error: r.isError });
      }
      messages.push({ role: "user", content: results });
    }
    return outOfRounds;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof Anthropic.APIConnectionError) throw new HttpError(502, "Couldn't reach Claude. Check the server's internet connection and try again.");
    if (error instanceof Anthropic.APIError) throw failed(ai, error.status ?? 502, error.message);
    throw error;
  }
}

type GeminiPart = { text?: string; thought?: boolean; functionCall?: { id?: string; name: string; args?: unknown }; [k: string]: unknown };
type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };

async function chatGemini({ system, turns, ai, meter, tools: TOOLS, runTool, maxRounds = DEFAULT_ROUNDS }: Run): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(ai.model)}:generateContent`;
  const contents: GeminiContent[] = turns.map((t) => ({ role: t.role === "assistant" ? "model" : "user", parts: [{ text: t.content }] }));
  for (let round = 0; round < maxRounds; round++) {
    const data = (await post(
      ai,
      url,
      { "x-goog-api-key": ai.key },
      {
        systemInstruction: { parts: [{ text: system }] },
        contents,
        tools: [{ functionDeclarations: TOOLS }],
      }
    )) as {
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
      promptFeedback?: { blockReason?: string };
      candidates?: { finishReason?: string; content?: GeminiContent }[];
    };
    meter.input += data.usageMetadata?.promptTokenCount ?? 0;
    meter.output += (data.usageMetadata?.candidatesTokenCount ?? 0) + (data.usageMetadata?.thoughtsTokenCount ?? 0);
    const candidate = data.candidates?.[0];
    if (data.promptFeedback?.blockReason || !candidate?.content) throw refused(ai);
    const parts = candidate.content.parts ?? [];
    const calls = parts.filter((p) => p.functionCall);
    if (!calls.length) {
      if (candidate.finishReason === "MAX_TOKENS") throw new HttpError(502, "The answer came back incomplete. Try a narrower question.");
      if (candidate.finishReason && !["STOP", "FINISH_REASON_UNSPECIFIED"].includes(candidate.finishReason)) throw refused(ai);
      return parts.filter((p) => !p.thought && p.text).map((p) => p.text).join("").trim() || outOfRounds;
    }
    // the model's turn goes back exactly as it came (its thought signatures with it)
    contents.push({ role: "model", parts });
    const responses: GeminiPart[] = [];
    for (const call of calls) {
      const fc = call.functionCall!;
      const r = await runTool(fc.name, fc.args ?? {});
      responses.push({
        functionResponse: { name: fc.name, ...(fc.id ? { id: fc.id } : {}), response: r.isError ? { error: r.text } : { result: JSON.parse(r.text) } },
      });
    }
    contents.push({ role: "user", parts: responses });
  }
  return outOfRounds;
}

type OpenAiMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; content: string };

async function chatChatGpt({ system, turns, ai, meter, tools: TOOLS, runTool, maxRounds = DEFAULT_ROUNDS }: Run): Promise<string> {
  const messages: OpenAiMessage[] = [{ role: "system", content: system }, ...turns.map((t) => ({ role: t.role, content: t.content }) as OpenAiMessage)];
  const tools = TOOLS.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
  for (let round = 0; round < maxRounds; round++) {
    const data = (await post(ai, "https://api.openai.com/v1/chat/completions", { Authorization: `Bearer ${ai.key}` }, { model: ai.model, messages, tools })) as {
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      choices?: {
        finish_reason?: string;
        message?: { content?: string | null; refusal?: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] };
      }[];
    };
    meter.input += data.usage?.prompt_tokens ?? 0;
    meter.output += data.usage?.completion_tokens ?? 0;
    const choice = data.choices?.[0];
    if (!choice?.message || choice.message.refusal) throw refused(ai);
    const calls = choice.message.tool_calls ?? [];
    if (!calls.length) {
      if (choice.finish_reason === "length") throw new HttpError(502, "The answer came back incomplete. Try a narrower question.");
      return (choice.message.content ?? "").trim() || outOfRounds;
    }
    messages.push({ role: "assistant", content: choice.message.content ?? null, tool_calls: calls });
    for (const call of calls) {
      let args: unknown = {};
      try {
        args = JSON.parse(call.function.arguments || "{}");
      } catch {
        // runTool reports the missing fields
      }
      const r = await runTool(call.function.name, args);
      messages.push({ role: "tool", tool_call_id: call.id, content: r.isError ? `Error: ${r.text}` : r.text });
    }
  }
  return outOfRounds;
}

// A conversation with tools, with whichever AI is chosen in Administration → AI.
export function chatWithTools(run: Run): Promise<string> {
  return run.ai.provider === "anthropic" ? chatClaude(run) : run.ai.provider === "gemini" ? chatGemini(run) : chatChatGpt(run);
}
