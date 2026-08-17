const DEEPSEEK_API_URL = "https://api.deepseek.com/v1/chat/completions";

/** Default timeout per request. Individual stages may override via ChatOptions.timeoutMs. */
const DEFAULT_TIMEOUT_MS = 60_000;

/** Provider-supported maximum output tokens for deepseek-v4-flash. */
const MAX_TOKENS_LIMIT = 32768;

/** Default output budget for every call. Document-generation calls that once
 *  passed a lower explicit budget (16,384) truncate on large inputs; the
 *  default is now the full 32,768 provider limit for all calls. */
const DEFAULT_MAX_TOKENS = 32768;

/** Warn before a call when the estimated input plus output budget exceeds this. */
const MAX_CONTEXT_BUDGET = 100_000;

/** Retry budget multipliers for reasoning-token exhaustion (finish_reason=length with empty content). */
const TOKEN_EXHAUSTION_MULTIPLIERS = [1.5, 2];

// ── Stage-aware thinking configuration ──
// deepseek-v4-flash performs hidden reasoning (reasoning_content) by default,
// consuming the max_tokens budget before producing message.content. Every call
// must explicitly assign a thinking mode; the provider default is never relied on.

export type ThinkingMode = "enabled" | "disabled";

/** Routine deterministic stages — thinking disabled. */
const THINKING_DISABLED_STAGES = new Set([
  // blog generation
  "outline", "outline_retry",
  "intro", "intro_retry", "intro_repair",
  "faq",
  "conclusion", "conclusion_retry", "conclusion_repair",
  // component regenerator / fixers / section expander (default stage)
  "pipeline",
  "claim_fix",
  // editorial rewriting & repairs
  "editorial-polish", "editorial-malformed-repair", "editorial-post-cleanup-repair",
  "editorial-repetition-repair", "editorial-prose-only-fallback",
  "final-document-diagnosis", "final-document-patch", "final-document-acceptance",
  "final-trim-compaction",
  // translation
  "cta", "metadata-final",
  "conc-shadow", "conc-shadow-repair",
  "translate-text", "translate-html", "metadata",
  "introduction",
]);

/** Stage prefixes that are routine and deterministic — thinking disabled. */
const THINKING_DISABLED_PREFIXES = ["section_", "section-", "faq-", "translate-"];

/** Stage suffixes that indicate routine repair/rewrite operations — thinking disabled. */
const THINKING_DISABLED_SUFFIXES = ["-strict-repair", "-editorial-repair", "-plain", "_repair", "-repair", "_retry", "-retry"];

/** High-level reasoning stages that genuinely benefit from thinking. */
const THINKING_ENABLED_STAGES = new Set([
  "factual-risk", "factual-risk-diagnosis", "factual-scan",
  "evidence", "evidence-reconciliation",
  "editorial-evaluation", "quality-diagnosis", "quality-assessment",
]);

function resolveThinkingMode(stage: string, explicit?: ThinkingMode): ThinkingMode {
  if (explicit === "enabled" || explicit === "disabled") return explicit;
  const s = stage.toLowerCase().trim();
  if (THINKING_ENABLED_STAGES.has(s)) return "enabled";
  if (THINKING_DISABLED_STAGES.has(s)) return "disabled";
  if (THINKING_DISABLED_PREFIXES.some((prefix) => s.startsWith(prefix))) return "disabled";
  if (THINKING_DISABLED_SUFFIXES.some((suffix) => s.endsWith(suffix))) return "disabled";
  // Unknown stage — never rely on the provider default (which is thinking ON).
  console.warn(`[deepseek:${stage}] ⚠️ no thinking mode assigned for stage — defaulting to disabled`);
  return "disabled";
}

/** Generate a short unique request ID for tracing. */
let requestIdCounter = 0;
function nextRequestId(): string {
  requestIdCounter++;
  return "req_" + Date.now().toString(36) + "_" + requestIdCounter.toString(36);
}

export type DeepSeekErrorType =
  | "timeout"
  | "invalid_json"
  | "rate_limit"
  | "api_failure"
  | "network_failure"
  | "empty_response"
  | "token_exhaustion"
  | "truncated";

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
  timeoutMs?: number;
  thinkingMode?: ThinkingMode;
  /** DeepSeek reasoning effort (low/medium/high), applied when thinking is enabled. */
  reasoningEffort?: "low" | "medium" | "high";
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  stop?: string[];
  responseFormat?: { type: "json_object" | "text" };
}

export interface ChatResult {
  content: string;
  finishReason?: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  model: string;
  /** Number of retry attempts actually consumed beyond the first. 0 = first attempt succeeded. */
  attemptsUsed: number;
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
      reasoning_content?: string;
    };
    finish_reason: string;
  }[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
    completion_tokens_details?: {
      reasoning_tokens?: number;
    };
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
  timeoutMs: number,
  stage: string,
  requestId: string,
  attempt: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
    console.log(`[deepseek:${stage}:${requestId}] attempt ${attempt} timed out after ${timeoutMs}ms`);
  }, timeoutMs);

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
  options: ChatOptions = {},
  stage = "unknown",
  requestId = nextRequestId(),
  attempt = 1,
): Promise<ChatResult> {
  const apiKey = getApiKey();
  const model = options.model ?? "deepseek-v4-flash";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const thinkingMode = resolveThinkingMode(stage, options.thinkingMode);
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;

  const body: Record<string, unknown> = {
    model,
    messages,
    stream: false,
    temperature: options.temperature ?? 0.7,
    max_tokens: maxTokens,
    thinking: { type: thinkingMode },
  };

  if (options.reasoningEffort && thinkingMode === "enabled") body.reasoning_effort = options.reasoningEffort;

  if (options.topP !== undefined) body.top_p = options.topP;
  if (options.frequencyPenalty !== undefined) body.frequency_penalty = options.frequencyPenalty;
  if (options.presencePenalty !== undefined) body.presence_penalty = options.presencePenalty;
  if (options.stop) body.stop = options.stop;
  if (options.responseFormat) body.response_format = options.responseFormat;

  const estimatedInputTokens = Math.round(messages.reduce((sum, message) => sum + message.content.length, 0) / 4);
  if (estimatedInputTokens + maxTokens > MAX_CONTEXT_BUDGET) {
    console.warn(
      `[deepseek:${stage}:${requestId}] ⚠️ large context: estimated input_tokens≈${estimatedInputTokens} + max_tokens=${maxTokens} = ${estimatedInputTokens + maxTokens} > ${MAX_CONTEXT_BUDGET}`,
    );
  }
  console.log(`[deepseek:${stage}:${requestId}] model=${model} | thinking=${thinkingMode} | max_tokens=${maxTokens} | timeout=${timeoutMs}ms | attempt=${attempt} | input_tokens≈${estimatedInputTokens}`);

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
    timeoutMs,
    stage,
    requestId,
    attempt,
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

  const choice = data.choices?.[0];
  const rawContent = choice?.message?.content;
  const reasoningContent = choice?.message?.reasoning_content;
  const finishReason = choice?.finish_reason;
  const usage = data.usage ?? {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  };
  const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens;

  // ── Token-budget diagnostics (never logs prompts, generated content or keys) ──
  console.log(`[deepseek:${stage}:${requestId}] finish_reason=${finishReason} | completion_tokens=${usage.completion_tokens} | reasoning_tokens=${reasoningTokens ?? 0} | content_chars=${typeof rawContent === "string" ? rawContent.length : "n/a"} | reasoning_chars=${typeof reasoningContent === "string" ? reasoningContent.length : "n/a"}`);

  // Genuinely empty response (no choices, or no content and no reasoning) →
  // existing empty_response path.
  if (!data.choices || data.choices.length === 0) {
    throw new DeepSeekError("empty_response", "DeepSeek response had no choices");
  }
  if (typeof rawContent !== "string") {
    throw new DeepSeekError("empty_response", "DeepSeek response had no content in choices");
  }
  if (rawContent.length === 0 && !(typeof reasoningContent === "string" && reasoningContent.length > 0)) {
    throw new DeepSeekError("empty_response", "DeepSeek response had no content in choices");
  }

  // Reasoning-token exhaustion: content empty, finish_reason=length and the model
  // spent the whole budget thinking. Retried with a larger budget by chatWithRetry.
  if (rawContent.length === 0 && finishReason === "length" && typeof reasoningContent === "string" && reasoningContent.length > 0) {
    throw new DeepSeekError(
      "token_exhaustion",
      `Reasoning tokens exhausted the max_tokens budget (completion_tokens=${usage.completion_tokens}, reasoning_tokens=${reasoningTokens ?? 0}, finish_reason=length, content empty)`,
    );
  }

  // Truncated partial content: finish_reason=length with non-empty content means
  // the response was cut off mid-generation. The partial prose/JSON is unusable
  // and must NEVER be parsed or accepted — escalate the budget and retry.
  if (rawContent.length > 0 && finishReason === "length") {
    throw new DeepSeekError(
      "truncated",
      `Response truncated (finish_reason=length) after ${rawContent.length} chars — partial content discarded (completion_tokens=${usage.completion_tokens}, reasoning_tokens=${reasoningTokens ?? 0})`,
    );
  }

  const content = rawContent;
  if (finishReason === "length") {
    console.warn(`[deepseek:${stage}:${requestId}] ⚠️ finish_reason=length — generation truncated`);
  }
  if (finishReason === "stop") {
    console.log(`[deepseek:${stage}:${requestId}] ✓ completed naturally`);
  }

  return {
    content,
    finishReason,
    usage: {
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
    },
    model: data.model,
    attemptsUsed: 0,
  };
}

export async function chatWithRetry(
  messages: ChatMessage[],
  options: ChatOptions = {},
  stage = "unknown",
  maxRetries = 2,
): Promise<ChatResult> {
  const requestId = nextRequestId();
  let lastError: DeepSeekError | null = null;
  // Budget actually used by the last attempt. Escalation stays base-relative
  // (retry 1 = base × 1.5, retry 2 = base × 2) but a retry is never issued
  // when its escalated budget equals a budget already used: after saturating
  // the provider maximum (default 32,768), an identical-budget retry cannot
  // succeed and only wastes a full token allowance.
  const baseBudget = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  let lastBudgetUsed = baseBudget;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Escalate the budget on reasoning-token exhaustion OR truncation:
    // first retry ×1.5, second retry ×2, capped at the provider maximum.
    let attemptOptions = options;
    if (attempt > 0 && (lastError?.type === "token_exhaustion" || lastError?.type === "truncated")) {
      const multiplier = TOKEN_EXHAUSTION_MULTIPLIERS[attempt - 1] ?? TOKEN_EXHAUSTION_MULTIPLIERS[TOKEN_EXHAUSTION_MULTIPLIERS.length - 1];
      const escalated = Math.min(MAX_TOKENS_LIMIT, Math.floor(baseBudget * multiplier));
      if (escalated <= lastBudgetUsed) {
        // The escalated budget would be identical to (or below) the budget the
        // last attempt already saturated. Escalating is impossible, so an
        // identical-budget retry would repeat the same failure — fail safely.
        console.log(`[deepseek:${stage}:${requestId}] ${lastError.type} — max_tokens already ${lastBudgetUsed}; skipping identical-budget retry`);
        break;
      }
      lastBudgetUsed = escalated;
      attemptOptions = { ...options, maxTokens: escalated };
      console.log(`[deepseek:${stage}:${requestId}] ${lastError.type} — retrying with max_tokens ${lastBudgetUsed}`);
    }

    try {
      const result = await chat(messages, attemptOptions, stage, requestId, attempt + 1);
      result.attemptsUsed = attempt;
      return result;
    } catch (err) {
      if (err instanceof DeepSeekError) {
        lastError = err;
        console.error(`[deepseek:${stage}:${requestId}] attempt ${attempt + 1}/${maxRetries + 1} failed (${err.type}): ${err.message}`);
        // Permanent 4xx errors other than 429 should not be retried
        if (err.type === "api_failure" && err.status && err.status >= 400 && err.status < 500 && err.status !== 429) {
          break;
        }
      } else {
        lastError = new DeepSeekError("api_failure", err instanceof Error ? err.message : String(err));
        console.error(`[deepseek:${stage}:${requestId}] attempt ${attempt + 1}/${maxRetries + 1} failed (unexpected): ${lastError.message}`);
      }

      if (attempt < maxRetries) {
        const delayMs = 1000 * Math.pow(2, attempt);
        console.log(`[deepseek:${stage}:${requestId}] retrying attempt ${attempt + 2}/${maxRetries + 1} in ${delayMs}ms`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  throw lastError ?? new DeepSeekError("api_failure", "DeepSeek request failed after all retries");
}

function createDeepSeekClient() {
  return { chat, chatWithRetry };
}

// ── Unified AI Service ──
// Single entry point for all AI model interactions.
// Owns retries, metrics, tracing, and timeout handling.
// No other module may call chat/chatWithRetry directly — use AiService.

export interface AiCallTracer {
  recordAiCall(record: { stage: string; durationMs: number; promptChars: number; completionChars: number; completed: boolean; jsonRepaired: boolean }): void;
  startTimer(label: string): void;
  endTimer(label: string): void;
  recordMetric(key: string, value: number): void;
}

export class AiService {
  private chatFn: typeof chat;
  private chatWithRetryFn: typeof chatWithRetry;

  constructor(
    private tracer?: AiCallTracer,
  ) {
    const client = createDeepSeekClient();
    this.chatFn = client.chat;
    this.chatWithRetryFn = client.chatWithRetry;
  }

  /** Single entry point for all AI calls. Wraps chatWithRetry with metrics/tracing. */
  async call(stage: string, messages: ChatMessage[], options?: ChatOptions): Promise<ChatResult> {
    const promptChars = messages.reduce((s, m) => s + m.content.length, 0);
    try {
      const result = await this.chatWithRetryFn(messages, options, stage);
      this.tracer?.recordAiCall({ stage, durationMs: 0, promptChars, completionChars: result.content.length, completed: true, jsonRepaired: false });
      return result;
    } catch (e) {
      this.tracer?.recordAiCall({ stage, durationMs: 0, promptChars, completionChars: 0, completed: false, jsonRepaired: false });
      throw e;
    }
  }

  /** Returns a stage-fixed call function for use in GenContext-style signatures. */
  makeCallerForStage(stage: string): (messages: ChatMessage[], options?: ChatOptions) => Promise<ChatResult> {
    return (messages: ChatMessage[], options?: ChatOptions) => this.call(stage, messages, options);
  }

  /** Raw chat (no retry). Used by playground and SEO normalizer. */
  get chat(): typeof chat {
    return this.chatFn;
  }

  /** Retry-wrapped chat. Used by services that need retry.
   *  Wraps the inner function to provide a default stage name for callers
   *  (like component-regenerator and fixers) that do not pass one. */
  get chatWithRetry(): typeof chatWithRetry {
    return (messages: ChatMessage[], options?: ChatOptions, stage = "pipeline", maxRetries?: number) => {
      return this.chatWithRetryFn(messages, options, stage, maxRetries);
    };
  }
}
