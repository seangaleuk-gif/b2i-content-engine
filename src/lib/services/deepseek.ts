const DEEPSEEK_API_URL = "https://api.deepseek.com/v1/chat/completions";
const TIMEOUT_MS = 60_000;

export type DeepSeekErrorType =
  | "timeout"
  | "invalid_json"
  | "rate_limit"
  | "api_failure"
  | "network_failure"
  | "empty_response";

export class DeepSeekError extends Error {
  type: DeepSeekErrorType;
  status?: number;

  constructor(type: DeepSeekErrorType, message: string, status?: number) {
    super(message);
    this.name = "DeepSeekError";
    this.type = type;
    this.status = status;
  }
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  stop?: string[];
  responseFormat?: { type: "json_object" | "text" };
}

export interface ChatResult {
  content: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  model: string;
}

export interface ChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: {
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
  };
}

function getApiKey(): string {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) {
    throw new DeepSeekError("api_failure", "DEEPSEEK_API_KEY environment variable is not configured");
  }
  return key;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    return response;
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new DeepSeekError("timeout", `Request timed out after ${timeoutMs}ms`);
    }
    throw new DeepSeekError(
      "network_failure",
      `Network error: ${err instanceof Error ? err.message : String(err)}`
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function parseResponseBody(response: Response): Promise<ChatResponse> {
  const text = await response.text();

  if (!text || text.trim().length === 0) {
    throw new DeepSeekError("empty_response", "Empty response body from DeepSeek API");
  }

  try {
    return JSON.parse(text) as ChatResponse;
  } catch {
    throw new DeepSeekError("invalid_json", `Failed to parse DeepSeek response as JSON: ${text.slice(0, 200)}`);
  }
}

function classifyHttpError(status: number): DeepSeekErrorType {
  if (status === 429) return "rate_limit";
  if (status >= 400 && status < 500) return "api_failure";
  return "api_failure";
}

export async function chat(
  messages: ChatMessage[],
  options: ChatOptions = {}
): Promise<ChatResult> {
  const apiKey = getApiKey();
  const model = options.model ?? "deepseek-chat";

  const body: Record<string, unknown> = {
    model,
    messages,
    stream: false,
    temperature: options.temperature ?? 0.7,
    max_tokens: options.maxTokens ?? 32768,
  };

  if (options.topP !== undefined) body.top_p = options.topP;
  if (options.frequencyPenalty !== undefined) body.frequency_penalty = options.frequencyPenalty;
  if (options.presencePenalty !== undefined) body.presence_penalty = options.presencePenalty;
  if (options.stop) body.stop = options.stop;
  if (options.responseFormat) body.response_format = options.responseFormat;

  const promptSizes = messages.map((m) => `${m.role}:${m.content.length}`).join(", ");
  const totalPromptChars = messages.reduce((sum, m) => sum + m.content.length, 0);
  console.log(`[deepseek:REQ] model=${model} | max_tokens=${body.max_tokens} | temperature=${body.temperature}`);
  console.log(`[deepseek:REQ] messages=[${promptSizes}] | total_chars=${totalPromptChars} | ~${Math.round(totalPromptChars / 4)} tokens`);
  console.log(`[deepseek:REQ] body keys: ${Object.keys(body).join(", ")}`);
  if (body.stop) console.log(`[deepseek:REQ] stop sequences: ${JSON.stringify(body.stop)}`);
  if (body.frequency_penalty !== undefined) console.log(`[deepseek:REQ] frequency_penalty: ${body.frequency_penalty}`);
  if (body.presence_penalty !== undefined) console.log(`[deepseek:REQ] presence_penalty: ${body.presence_penalty}`);

  const response = await fetchWithTimeout(
    DEEPSEEK_API_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    },
    TIMEOUT_MS
  );

  if (!response.ok) {
    const errorType = classifyHttpError(response.status);
    let errorBody = "";
    try {
      errorBody = await response.text();
    } catch {
      // ignore
    }
    const errorSnippet = errorBody ? errorBody.slice(0, 300) : "(no body)";
    throw new DeepSeekError(
      errorType,
      `DeepSeek API returned ${response.status}: ${errorSnippet}`,
      response.status
    );
  }

  const data = await parseResponseBody(response);

  if (!data.choices || data.choices.length === 0 || !data.choices[0].message?.content) {
    throw new DeepSeekError("empty_response", "DeepSeek response had no content in choices");
  }

  const content = data.choices[0].message.content;
  const finishReason = data.choices[0].finish_reason;
  const usage = data.usage ?? {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  };

  // ── Response path verification ──
  console.log(`[deepseek:PATH] HTTP body → parseResponseBody() → ChatResponse`);
  console.log(`[deepseek:PATH] ChatResponse.choices[0].message.content → typeof=${typeof content} length=${content.length}`);
  console.log(`[deepseek:PATH] finish_reason=${finishReason}`);
  if (typeof content !== "string") {
    console.warn(`[deepseek:PATH] ⚠️ content is NOT a string — type is ${typeof content}`);
  }

  console.log(
    `[deepseek:RES] model=${data.model} | finish_reason=${finishReason}`
  );
  console.log(
    `[deepseek:RES] tokens_in=${usage.prompt_tokens} tokens_out=${usage.completion_tokens} total=${usage.total_tokens}`
  );
  console.log(
    `[deepseek:RES] content_chars=${content.length} | ~${content.split(/\s+/).filter(Boolean).length} words`
  );
  if (finishReason === "length") {
    console.warn(`[deepseek:RES] ⚠️ FINISH_REASON=LENGTH — generation was truncated! Increase max_tokens.`);
  }
  if (finishReason === "stop") {
    console.log(`[deepseek:RES] ✓ finish_reason=stop — generation completed naturally.`);
  }

  return {
    content,
    usage: {
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
    },
    model: data.model,
  };
}

export async function chatWithRetry(
  messages: ChatMessage[],
  options: ChatOptions = {},
  maxRetries = 2
): Promise<ChatResult> {
  let lastError: DeepSeekError | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await chat(messages, options);
    } catch (err) {
      if (err instanceof DeepSeekError) {
        lastError = err;
        console.error(`[deepseek] Attempt ${attempt + 1}/${maxRetries + 1} failed (${err.type}): ${err.message}`);
      } else {
        lastError = new DeepSeekError("api_failure", err instanceof Error ? err.message : String(err));
        console.error(`[deepseek] Attempt ${attempt + 1}/${maxRetries + 1} failed (unexpected): ${lastError.message}`);
      }

      if (attempt < maxRetries) {
        const delayMs = 1000 * Math.pow(2, attempt);
        console.log(`[deepseek] Retrying in ${delayMs}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  throw lastError ?? new DeepSeekError("api_failure", "DeepSeek request failed after all retries");
}

export function createDeepSeekClient() {
  return { chat, chatWithRetry };
}
