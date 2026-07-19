"use client";

import { useState, useCallback } from "react";
import {
  Search,
  Plus,
  MoreHorizontal,
  Clock,
  Copy,
  Play,
  Code2,
} from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { useData } from "@/lib/use-data";
import { api } from "@/lib/api-client";
import { formatDate } from "@/lib/utils";

interface Prompt {
  id: number;
  name: string;
  purpose: string;
  tags: string[];
  updatedAt: string;
  template: string;
  variables: Record<string, string>;
}

function PromptsSkeleton() {
  return (
    <div className="flex h-full">
      <div className="flex-1 px-10 py-8">
        <div className="flex items-center justify-between mb-8">
          <div>
            <Skeleton variant="text" width={250} height={38} />
            <Skeleton variant="text" width={120} className="mt-1" />
          </div>
          <Skeleton variant="rectangular" width={150} height={38} />
        </div>
        <Skeleton variant="rectangular" width={400} height={38} className="mb-6" />
        <div className="space-y-2">
          {[1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} variant="rectangular" height={100} />
          ))}
        </div>
      </div>
    </div>
  );
}

export default function PromptLibraryPage() {
  const [selected, setSelected] = useState<Prompt | null>(null);
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [variableValues, setVariableValues] = useState<Record<string, string>>(
    {}
  );
  const { data: prompts, loading, refetch } = useData<Prompt[]>(() =>
    api.get("/api/prompts")
  );

  const handleCreate = useCallback(async () => {
    setCreating(true);
    try {
      await api.post("/api/prompts", {
        name: "Untitled Prompt",
        purpose: "",
        tags: [],
        template: "",
        variables: {},
      });
      await refetch();
    } catch {
    } finally {
      setCreating(false);
    }
  }, [refetch]);

  const assemblePrompt = (prompt: Prompt) => {
    let result = prompt.template;
    const vars = typeof prompt.variables === "object" ? Object.keys(prompt.variables) : [];
    vars.forEach((v) => {
      result = result.replace(
        new RegExp(`\\{${v}\\}`, "g"),
        variableValues[v] || `{${v}}`
      );
    });
    return result;
  };

  if (loading) return <PromptsSkeleton />;

  const list = prompts ?? [];

  return (
    <div className="flex h-full">
      <div className="flex-1 flex flex-col min-w-0">
        <div className="px-10 py-8">
          <div className="flex items-center justify-between mb-8">
            <div>
              <h1 className="text-[38px] font-bold text-text-primary tracking-tight">
                Prompt Library
              </h1>
              <p className="text-[14px] text-text-secondary mt-1">
                {list.length} saved prompts
              </p>
            </div>
            <Button icon={<Plus size={16} />} onClick={handleCreate} loading={creating}>
              {creating ? "Creating..." : "New Prompt"}
            </Button>
          </div>

          <div className="relative max-w-md mb-6">
            <Search
              size={16}
              className="absolute left-3.5 top-1/2 -translate-y-1/2 text-text-secondary"
            />
            <input
              type="text"
              placeholder="Search prompts..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full bg-bg-surface border border-border-subtle rounded-[10px] pl-10 pr-4 py-2.5 text-[14px] text-text-primary placeholder:text-text-secondary/50 focus:outline-none focus:border-accent-primary/50 transition-all"
            />
          </div>

          {list.length === 0 ? (
            <EmptyState
              title="No prompts yet"
              description="Create your first prompt template to streamline content generation."
              actionLabel="New Prompt"
              onAction={handleCreate}
            />
          ) : (
            <div className="space-y-2">
              {list.map((prompt) => (
                <Card
                  key={prompt.id}
                  hover
                  padding="md"
                  className={`cursor-pointer ${
                    selected?.id === prompt.id
                      ? "border-accent-primary/50 bg-accent-primary/5"
                      : ""
                  }`}
                >
                  <div
                    className="flex items-center justify-between"
                    onClick={() => {
                      setSelected(prompt);
                      setVariableValues({});
                    }}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="text-[15px] font-semibold text-text-primary">
                          {prompt.name}
                        </h3>
                        <Code2 size={14} className="text-accent-primary" />
                      </div>
                      <p className="text-[13px] text-text-secondary">
                        {prompt.purpose}
                      </p>
                      <div className="flex items-center gap-2 mt-2">
                        {prompt.tags.map((tag) => (
                          <Badge key={tag} variant="neutral">
                            {tag}
                          </Badge>
                        ))}
                        <span className="text-[11px] text-text-secondary flex items-center gap-1">
                          <Clock size={10} />
                          {formatDate(prompt.updatedAt)}
                        </span>
                      </div>
                    </div>
                    <Button variant="ghost" size="sm" icon={<Play size={14} />}>
                      Use
                    </Button>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>
      </div>

      {selected && (
        <div className="w-[480px] shrink-0 border-l border-border-subtle bg-bg-surface overflow-y-auto">
          <div className="p-6">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-[20px] font-semibold text-text-primary">
                {selected.name}
              </h2>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<Copy size={14} />}
                  onClick={() => navigator.clipboard.writeText(selected.template)}
                >
                  Copy
                </Button>
                <Button variant="ghost" size="sm" icon={<MoreHorizontal size={14} />} disabled title="Actions coming soon" />
              </div>
            </div>

            <p className="text-[14px] text-text-secondary mb-6">
              {selected.purpose}
            </p>

            {typeof selected.variables === "object" && Object.keys(selected.variables).length > 0 && (
              <div className="mb-6">
                <h3 className="text-[14px] font-semibold text-text-primary mb-3">
                  Variables
                </h3>
                <div className="space-y-2.5">
                  {Object.keys(selected.variables).map((v) => (
                    <div key={v} className="flex items-center gap-3">
                      <span className="text-[13px] font-mono text-accent-primary w-28 shrink-0">
                        {"{" + v + "}"}
                      </span>
                      <input
                        type="text"
                        placeholder={`Enter ${v}...`}
                        value={variableValues[v] || ""}
                        onChange={(e) =>
                          setVariableValues((prev) => ({
                            ...prev,
                            [v]: e.target.value,
                          }))
                        }
                        className="flex-1 bg-bg-surface border border-border-subtle rounded-[8px] px-3 py-2 text-[13px] text-text-primary placeholder:text-text-secondary/40 focus:outline-none focus:border-accent-primary/50 transition-all"
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div>
              <h3 className="text-[14px] font-semibold text-text-primary mb-3">
                Assembled Prompt
              </h3>
              <pre className="bg-bg-surface-secondary border border-border-subtle rounded-[12px] p-4 text-[13px] text-text-primary font-mono leading-relaxed whitespace-pre-wrap overflow-x-auto">
                {assemblePrompt(selected)}
              </pre>
            </div>

            <Button className="w-full mt-6" icon={<Play size={16} />} disabled title="Coming soon">
              Run with AI
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
