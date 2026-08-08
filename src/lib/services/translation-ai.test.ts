import { describe, it, expect, vi, beforeEach } from "vitest";

const captured: Array<{ maxRetries: number | undefined }> = [];

vi.mock("@/lib/services/deepseek", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/services/deepseek")>();
  return {
    ...actual,
    AiService: class {
      chatWithRetry = async (
        _messages: unknown[],
        _options: Record<string, unknown>,
        _stage: string,
        maxRetries?: number,
      ) => {
        // Mirror deepseek's default: undefined -> 2 retries (3 attempts).
        captured.push({ maxRetries: maxRetries ?? 2 });
        return {
          content: "{}",
          finishReason: "stop",
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          model: "test",
          attemptsUsed: 0,
        };
      };
    },
  };
});

import { chatWithBudget } from "./translation-ai";
import { RetryBudget } from "./translation-types";

describe("chatWithBudget retry forwarding", () => {
  beforeEach(() => {
    captured.length = 0;
  });

  it("maxRetries:0 is forwarded as the retry limit (exactly one entry, no attempt 1/3)", async () => {
    const result = await chatWithBudget(
      [{ role: "user", content: "translate" }],
      { maxRetries: 0, maxTokens: 100 },
      "test-stage",
    );
    expect(captured).toHaveLength(1);
    expect(captured[0].maxRetries).toBe(0);
    expect(result.content).toBe("{}");
  });

  it("unspecified retry settings preserve the production default (2 retries)", async () => {
    await chatWithBudget(
      [{ role: "user", content: "translate" }],
      { maxTokens: 100 },
      "test-stage",
    );
    expect(captured).toHaveLength(1);
    expect(captured[0].maxRetries).toBe(2);
  });

  it("an explicit budget does not raise the retry count above the requested value", async () => {
    await chatWithBudget(
      [{ role: "user", content: "translate" }],
      { maxRetries: 1, maxTokens: 100 },
      "test-stage",
    );
    expect(captured[0].maxRetries).toBe(1);
  });

  it("an exhausted shared budget caps a default-retry call at zero", async () => {
    const budget = new RetryBudget(1);
    budget.record("previous-stage", 1, false);
    await chatWithBudget(
      [{ role: "user", content: "translate" }],
      { maxTokens: 100 },
      "next-stage",
      budget,
    );
    expect(captured[0].maxRetries).toBe(0);
  });
});
