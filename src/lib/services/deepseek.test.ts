import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chat, chatWithRetry, DeepSeekError, type ChatOptions } from "./deepseek";

const API_URL = "https://api.deepseek.com/v1/chat/completions";

function mockFetchResponse(body: unknown, status = 200): void {
  const payload = JSON.stringify(body);
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async () =>
      new Response(payload, { status, headers: { "Content-Type": "application/json" } }),
    ),
  );
}

function exhaustionBody(reasoning: string, completionTokens: number): unknown {
  return {
    id: "test-id",
    object: "chat.completion",
    created: 1,
    model: "deepseek-v4-flash",
    choices: [{
      index: 0,
      message: { role: "assistant", content: "", reasoning_content: reasoning },
      finish_reason: "length",
    }],
    usage: {
      prompt_tokens: 100,
      completion_tokens: completionTokens,
      total_tokens: 100 + completionTokens,
      completion_tokens_details: { reasoning_tokens: completionTokens },
    },
  };
}

function successBody(content: string): unknown {
  return {
    id: "test-id",
    object: "chat.completion",
    created: 1,
    model: "deepseek-v4-flash",
    choices: [{
      index: 0,
      message: { role: "assistant", content, reasoning_content: "internal thinking" },
      finish_reason: "stop",
    }],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      completion_tokens_details: { reasoning_tokens: 10 },
    },
  };
}

function emptyBody(): unknown {
  return {
    id: "test-id",
    object: "chat.completion",
    created: 1,
    model: "deepseek-v4-flash",
    choices: [{
      index: 0,
      message: { role: "assistant", content: "", reasoning_content: "" },
      finish_reason: "stop",
    }],
    usage: { prompt_tokens: 100, completion_tokens: 0, total_tokens: 100 },
  };
}

function lastFetchBody(): Record<string, unknown> {
  const fetchMock = vi.mocked(fetch);
  const call = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
  return JSON.parse(String(call?.[1]?.body)) as Record<string, unknown>;
}

beforeEach(() => {
  process.env.DEEPSEEK_API_KEY = "sk-test-key-for-unit-tests-only";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.DEEPSEEK_API_KEY;
});

describe("chatWithRetry reasoning-token exhaustion", () => {
  it("empty content + finish_reason=length + reasoning content triggers a larger-budget retry", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => {
        calls++;
        if (calls === 1) {
          return new Response(JSON.stringify(exhaustionBody("thinking hard", 4000)), { status: 200 });
        }
        return new Response(JSON.stringify(successBody("{\"ok\":true}")), { status: 200 });
      }),
    );

    const result = await chatWithRetry(
      [{ role: "user", content: "test" }],
      { maxTokens: 4000 },
      "test-stage",
      1,
    );
    expect(calls).toBe(2);
    expect(result.content).toBe('{"ok":true}');
    expect(result.attemptsUsed).toBe(1);

    // First retry must use original × 1.5 = 6000
    const retryBody = lastFetchBody();
    expect(retryBody.max_tokens).toBe(6000);
  });

  it("successful retry returns normal content and never exposes reasoning_content", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => {
        calls++;
        if (calls === 1) {
          return new Response(JSON.stringify(exhaustionBody("thinking", 8192)), { status: 200 });
        }
        return new Response(JSON.stringify(successBody("the real answer")), { status: 200 });
      }),
    );

    const result = await chatWithRetry(
      [{ role: "user", content: "test" }],
      { maxTokens: 8192 },
      "test-stage",
      1,
    );
    expect(result.content).toBe("the real answer");
    expect(result.content).not.toContain("thinking");
  });

  it("second retry escalates to original × 2", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => {
        calls++;
        if (calls <= 2) {
          return new Response(JSON.stringify(exhaustionBody("still thinking", 5000)), { status: 200 });
        }
        return new Response(JSON.stringify(successBody("ok")), { status: 200 });
      }),
    );

    const result = await chatWithRetry(
      [{ role: "user", content: "test" }],
      { maxTokens: 5000 },
      "test-stage",
      2,
    );
    expect(calls).toBe(3);
    expect(result.content).toBe("ok");

    // Second retry: 5000 × 2 = 10000
    const retryBody = lastFetchBody();
    expect(retryBody.max_tokens).toBe(10000);
  });

  it("retry budgets respect the configured maximum (32768)", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => {
        calls++;
        if (calls <= 2) {
          return new Response(JSON.stringify(exhaustionBody("thinking", 25000)), { status: 200 });
        }
        return new Response(JSON.stringify(successBody("ok")), { status: 200 });
      }),
    );

    const result = await chatWithRetry(
      [{ role: "user", content: "test" }],
      { maxTokens: 25000 },
      "test-stage",
      2,
    );
    expect(result.content).toBe("ok");

    // 25000 × 1.5 = 37500 → capped at 32768
    const retryBody = lastFetchBody();
    expect(retryBody.max_tokens).toBe(32768);
  });

  it("ordinary empty response (no reasoning) uses the existing retry behaviour", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => {
        calls++;
        if (calls === 1) {
          return new Response(JSON.stringify(emptyBody()), { status: 200 });
        }
        return new Response(JSON.stringify(successBody("recovered")), { status: 200 });
      }),
    );

    const result = await chatWithRetry(
      [{ role: "user", content: "test" }],
      { maxTokens: 4000 },
      "test-stage",
      1,
    );
    expect(calls).toBe(2);
    expect(result.content).toBe("recovered");

    // Ordinary empty response must NOT escalate the budget — stays at original
    const retryBody = lastFetchBody();
    expect(retryBody.max_tokens).toBe(4000);
  });

  it("empty content with finish_reason=stop remains a normal empty_response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({
          id: "x",
          object: "chat.completion",
          created: 1,
          model: "deepseek-v4-flash",
          choices: [{
            index: 0,
            message: { role: "assistant", content: "", reasoning_content: "" },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
        }), { status: 200 }),
      ),
    );

    await expect(
      chatWithRetry([{ role: "user", content: "test" }], { maxTokens: 4000 }, "test-stage", 0),
    ).rejects.toThrow("no content in choices");
  });

  it("normal successful responses remain unchanged (no retry, content intact)", async () => {
    mockFetchResponse(successBody("normal answer"));
    const result = await chatWithRetry(
      [{ role: "user", content: "test" }],
      { maxTokens: 4000 },
      "test-stage",
      2,
    );
    expect(result.content).toBe("normal answer");
    expect(result.attemptsUsed).toBe(0);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    expect(lastFetchBody().max_tokens).toBe(4000);
  });
});

describe("chat response inspection", () => {
  it("throws token_exhaustion for empty content + length + reasoning", async () => {
    mockFetchResponse(exhaustionBody("thinking", 100));
    await expect(
      chat([{ role: "user", content: "test" }], { maxTokens: 100 }, "test-stage", "req-test", 1),
    ).rejects.toMatchObject({ type: "token_exhaustion" });
  });

  it("exhaustion failure propagates after all retries when retry also exhausts", async () => {
    mockFetchResponse(exhaustionBody("thinking", 100));
    await expect(
      chatWithRetry([{ role: "user", content: "test" }], { maxTokens: 100 }, "test-stage", 2),
    ).rejects.toBeInstanceOf(DeepSeekError);
  });
});

describe("stage-aware thinking configuration", () => {
  it.each([
    ["outline"],
    ["intro"],
    ["section_3"],
    ["conclusion"],
    ["faq"],
    ["translate-html"],
    ["metadata-final"],
    ["editorial-polish"],
    ["editorial-malformed-repair"],
    ["claim_fix"],
    ["conc-shadow"],
  ])("routine stage %s explicitly disables thinking", async (stage) => {
    mockFetchResponse(successBody("ok"));
    await chatWithRetry([{ role: "user", content: "test" }], { maxTokens: 100 }, stage, 0);
    expect(lastFetchBody().thinking).toEqual({ type: "disabled" });
  });

  it.each([
    ["factual-risk"],
    ["evidence-reconciliation"],
    ["quality-diagnosis"],
  ])("reasoning stage %s explicitly enables thinking", async (stage) => {
    mockFetchResponse(successBody("ok"));
    await chatWithRetry([{ role: "user", content: "test" }], { maxTokens: 100 }, stage, 0);
    expect(lastFetchBody().thinking).toEqual({ type: "enabled" });
  });

  it("every request carries an explicit thinking field (never relies on provider default)", async () => {
    mockFetchResponse(successBody("ok"));
    await chatWithRetry([{ role: "user", content: "test" }], { maxTokens: 100 }, "section_0", 2);
    for (const call of vi.mocked(fetch).mock.calls) {
      const body = JSON.parse(String(call[1]?.body));
      expect(body.thinking).toBeDefined();
      expect(["enabled", "disabled"]).toContain(body.thinking.type);
    }
  });

  it("explicit thinkingMode option overrides stage default", async () => {
    mockFetchResponse(successBody("ok"));
    await chatWithRetry(
      [{ role: "user", content: "test" }],
      { maxTokens: 100, thinkingMode: "enabled" },
      "outline",
      0,
    );
    expect(lastFetchBody().thinking).toEqual({ type: "enabled" });
  });
});

describe("truncated partial-content handling", () => {
  it("finish_reason=length with partial content triggers a retry", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => {
        calls++;
        if (calls === 1) {
          return new Response(JSON.stringify({
            id: "x",
            object: "chat.completion",
            created: 1,
            model: "deepseek-v4-flash",
            choices: [{
              index: 0,
              message: { role: "assistant", content: '{"blocks": [{"type": "paragr', reasoning_content: "" },
              finish_reason: "length",
            }],
            usage: { prompt_tokens: 10, completion_tokens: 200, total_tokens: 210 },
          }), { status: 200 });
        }
        return new Response(JSON.stringify(successBody('{"blocks": [{"type": "paragraph", "text": "ok"}]}')), { status: 200 });
      }),
    );

    const result = await chatWithRetry(
      [{ role: "user", content: "test" }],
      { maxTokens: 200 },
      "section_0",
      1,
    );
    expect(calls).toBe(2);
    // The retry must use the escalated budget (200 × 1.5 = 300)
    expect(lastFetchBody().max_tokens).toBe(300);
    // The final content must be the complete retry response, not the partial one
    expect(result.content).toBe('{"blocks": [{"type": "paragraph", "text": "ok"}]}');
  });

  it("partial JSON is never returned to the caller (throws truncated)", async () => {
    mockFetchResponse({
      id: "x",
      object: "chat.completion",
      created: 1,
      model: "deepseek-v4-flash",
      choices: [{
        index: 0,
        message: { role: "assistant", content: '{"blocks": [{"type": "paragr', reasoning_content: "" },
        finish_reason: "length",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 200, total_tokens: 210 },
    });
    await expect(
      chatWithRetry([{ role: "user", content: "test" }], { maxTokens: 200 }, "section_0", 0),
    ).rejects.toMatchObject({ type: "truncated" });
  });

  it("truncated retries respect the 32,768 cap", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => {
        calls++;
        if (calls <= 2) {
          return new Response(JSON.stringify({
            id: "x",
            object: "chat.completion",
            created: 1,
            model: "deepseek-v4-flash",
            choices: [{
              index: 0,
              message: { role: "assistant", content: "partial", reasoning_content: "" },
              finish_reason: "length",
            }],
            usage: { prompt_tokens: 10, completion_tokens: 30000, total_tokens: 30010 },
          }), { status: 200 });
        }
        return new Response(JSON.stringify(successBody("ok")), { status: 200 });
      }),
    );

    const result = await chatWithRetry(
      [{ role: "user", content: "test" }],
      { maxTokens: 30000 },
      "section_0",
      2,
    );
    expect(result.content).toBe("ok");
    expect(lastFetchBody().max_tokens).toBe(32768);
  });
});
