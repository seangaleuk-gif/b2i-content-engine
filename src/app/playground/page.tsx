"use client";

import { useState, useRef, useCallback } from "react";
import { Send, RotateCcw, Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { api } from "@/lib/api-client";

const MODELS = [
  { value: "deepseek-chat", label: "DeepSeek Chat" },
  { value: "deepseek-reasoner", label: "DeepSeek Reasoner" },
];

interface PlaygroundResponse {
  content: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  model: string;
}

export default function PlaygroundPage() {
  const [systemPrompt, setSystemPrompt] = useState(
    "You are a helpful assistant."
  );
  const [userMessage, setUserMessage] = useState("");
  const [model, setModel] = useState("deepseek-chat");
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<PlaygroundResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [responseTime, setResponseTime] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const responseRef = useRef<HTMLPreElement>(null);

  const handleSend = useCallback(async () => {
    setLoading(true);
    setError(null);
    setResponse(null);
    setResponseTime(null);

    const startTime = Date.now();

    try {
      const result = await api.post<PlaygroundResponse>("/api/playground", {
        systemPrompt,
        userMessage,
        model,
      });
      setResponse(result);
      setResponseTime(Date.now() - startTime);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setLoading(false);
    }
  }, [systemPrompt, userMessage, model]);

  const handleRetry = useCallback(() => {
    handleSend();
  }, [handleSend]);

  const handleCopy = useCallback(async () => {
    if (response) {
      await navigator.clipboard.writeText(response.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [response]);

  return (
    <div className="max-w-[1200px] mx-auto px-10 py-8">
      <div className="mb-8">
        <h1 className="text-[28px] font-bold text-text-primary tracking-tight mb-1">
          Playground
        </h1>
        <p className="text-[13px] text-text-secondary">
          Test prompts against the DeepSeek API directly.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-6 h-[calc(100vh-180px)]">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-[13px] font-medium text-text-secondary">
              System Prompt
            </label>
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              rows={8}
              className="bg-bg-surface border border-border-subtle rounded-[10px] px-3.5 py-2.5 text-[13px] text-text-primary placeholder:text-text-secondary/50 focus:outline-none focus:border-accent-primary/50 focus:ring-1 focus:ring-accent-primary/20 transition-all duration-150 resize-none font-mono"
              placeholder="Enter system prompt..."
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-[13px] font-medium text-text-secondary">
              User Message
            </label>
            <textarea
              value={userMessage}
              onChange={(e) => setUserMessage(e.target.value)}
              rows={6}
              className="bg-bg-surface border border-border-subtle rounded-[10px] px-3.5 py-2.5 text-[13px] text-text-primary placeholder:text-text-secondary/50 focus:outline-none focus:border-accent-primary/50 focus:ring-1 focus:ring-accent-primary/20 transition-all duration-150 resize-none font-mono"
              placeholder="Enter user message..."
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-[13px] font-medium text-text-secondary">
              Model
            </label>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="bg-bg-surface border border-border-subtle rounded-[10px] px-3.5 py-2.5 text-[14px] text-text-primary focus:outline-none focus:border-accent-primary/50 focus:ring-1 focus:ring-accent-primary/20 transition-all duration-150"
            >
              {MODELS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2 mt-2">
            <Button
              onClick={handleSend}
              loading={loading}
              icon={<Send size={16} />}
            >
              Send
            </Button>
            {response && (
              <>
                <Button variant="secondary" onClick={handleRetry} disabled={loading}>
                  <RotateCcw size={16} />
                  <span className="ml-1.5">Retry</span>
                </Button>
                <Button variant="ghost" onClick={handleCopy}>
                  {copied ? <Check size={16} /> : <Copy size={16} />}
                  <span className="ml-1.5">{copied ? "Copied" : "Copy"}</span>
                </Button>
              </>
            )}
          </div>

          {responseTime !== null && (
            <p className="text-[12px] text-text-secondary">
              Response time: {(responseTime / 1000).toFixed(2)}s
            </p>
          )}
        </div>

        <div className="flex flex-col gap-3 min-h-0">
          {response && response.usage && (
            <div className="flex items-center gap-4 text-[12px] text-text-secondary shrink-0">
              <span>Prompt: {response.usage.promptTokens.toLocaleString()}</span>
              <span>Completion: {response.usage.completionTokens.toLocaleString()}</span>
              <span>Total: {response.usage.totalTokens.toLocaleString()}</span>
              <span className="text-text-secondary/60">Model: {response.model}</span>
            </div>
          )}

          <Card className="flex-1 min-h-0 overflow-hidden" padding="none">
            {error ? (
              <div className="p-5">
                <p className="text-[14px] text-accent-danger">{error}</p>
              </div>
            ) : response ? (
              <pre
                ref={responseRef}
                className="h-full overflow-auto p-5 text-[13px] text-text-primary font-mono leading-relaxed whitespace-pre-wrap break-words"
              >
                {response.content}
              </pre>
            ) : (
              <div className="flex items-center justify-center h-full text-text-secondary/40 text-[14px]">
                {loading ? "Generating..." : "Response will appear here"}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
