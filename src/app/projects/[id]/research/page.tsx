"use client";

import { useState, useCallback } from "react";
import { useParams } from "next/navigation";
import {
  Search,
  ExternalLink,
  Copy,
  Pin,
  BookOpen,
  Globe,
  Quote,
  BarChart3,
  HelpCircle,
  TrendingUp,
  Sparkles,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  MessageCircle,
} from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { useData } from "@/lib/use-data";
import { api } from "@/lib/api-client";

interface ResearchSource {
  id: number;
  category: string;
  title: string;
  snippet: string;
  url: string;
  position: number;
}

const sections = [
  { label: "Web Results", icon: Globe, type: "google" as const },
  { label: "Discussions", icon: MessageCircle, type: "discussion" as const },
  { label: "FAQ", icon: HelpCircle, type: "faq" as const },
  { label: "News", icon: TrendingUp, type: "news" as const },
  { label: "Related Searches", icon: TrendingUp, type: "related" as const },
  { label: "Knowledge Graph", icon: BookOpen, type: "knowledge" as const },
  { label: "Competitor Headlines", icon: BarChart3, type: "competitor" as const },
  { label: "Authority Sources", icon: BookOpen, type: "authority" as const },
];

const typeVariantMap: Record<string, "research" | "neutral" | "success" | "warning"> = {
  google: "neutral",
  discussion: "research",
  faq: "warning",
  news: "success",
  related: "warning",
  knowledge: "success",
  competitor: "neutral",
  statistic: "success",
  quote: "research",
  authority: "success",
};

function ResearchSkeleton() {
  return (
    <div className="max-w-[1400px] mx-auto px-10 py-8">
      <div className="flex items-center justify-between mb-10">
        <div>
          <Skeleton variant="text" width={200} height={38} />
          <Skeleton variant="text" width={250} className="mt-1" />
        </div>
        <Skeleton variant="rectangular" width={180} height={38} />
      </div>
      <div className="flex gap-6">
        <div className="w-[220px] space-y-0.5">
          {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
            <Skeleton key={i} variant="rectangular" height={36} />
          ))}
        </div>
        <div className="flex-1">
          <div className="grid grid-cols-2 gap-4">
            {[1, 2, 3, 4].map((i) => (
              <Skeleton key={i} variant="rectangular" height={180} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ResearchPage() {
  const params = useParams();
  const projectId = params.id as string;
  const [activeSection, setActiveSection] = useState<string>("google");
  const [pinnedSources, setPinnedSources] = useState<Set<number>>(new Set());
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [genSuccess, setGenSuccess] = useState(false);
  const [copiedId, setCopiedId] = useState<number | null>(null);

  const { data: sources, loading, refetch } = useData<ResearchSource[]>(
    () => api.get(`/api/projects/${projectId}/research`),
    []
  );

  const handleGenerate = useCallback(async () => {
    setGenerating(true);
    setGenError(null);
    setGenSuccess(false);

    try {
      await api.post<unknown>(`/api/projects/${projectId}/research/generate`, {});
      setGenSuccess(true);
      await refetch();
      setTimeout(() => setGenSuccess(false), 4000);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to generate research";
      setGenError(message);
    } finally {
      setGenerating(false);
    }
  }, [projectId, refetch]);

  const togglePin = (id: number) => {
    setPinnedSources((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleCopy = useCallback(
    (source: ResearchSource) => {
      navigator.clipboard.writeText(`${source.title}\n${source.url}`);
      setCopiedId(source.id);
      setTimeout(() => setCopiedId(null), 2000);
    },
    []
  );

  if (loading) return <ResearchSkeleton />;

  const items = sources ?? [];
  const filteredSources = items.filter((s) => s.category === activeSection);

  return (
    <div className="max-w-[1400px] mx-auto px-10 py-8">
      <div className="flex items-center justify-between mb-10">
        <div>
          <h1 className="text-[38px] font-bold text-text-primary tracking-tight">
            Research
          </h1>
          <p className="text-[14px] text-text-secondary mt-1">
            {items.length > 0
              ? `${items.length} research sources`
              : "AI-generated research for your content"}
          </p>
        </div>
        <Button
          icon={generating ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
          onClick={handleGenerate}
          disabled={generating}
        >
          {generating ? "Researching..." : "Generate Research"}
        </Button>
      </div>

      {genError && (
        <div className="mb-6 p-4 bg-accent-danger/10 border border-accent-danger/30 rounded-[12px] flex items-start gap-3">
          <AlertTriangle size={18} className="text-accent-danger shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-[14px] font-medium text-accent-danger">
              Research generation failed
            </p>
            <p className="text-[13px] text-text-secondary mt-0.5">{genError}</p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setGenError(null)}>
            Dismiss
          </Button>
        </div>
      )}

      {genSuccess && (
        <div className="mb-6 p-4 bg-accent-green/10 border border-accent-green/30 rounded-[12px] flex items-start gap-3">
          <CheckCircle2 size={18} className="text-accent-green shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-[14px] font-medium text-accent-green">
              Research complete
            </p>
            <p className="text-[13px] text-text-secondary mt-0.5">
              {items.length} sources found and saved.
            </p>
          </div>
        </div>
      )}

      {generating && items.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <Loader2 size={48} className="text-accent-primary animate-spin mb-4" />
          <h2 className="text-[20px] font-semibold text-text-primary mb-2">
            Searching the web...
          </h2>
          <p className="text-[14px] text-text-secondary mb-2">
            Gathering research data for your project
          </p>
        </div>
      )}

      {!generating && items.length === 0 && !genError && (
        <EmptyState
          icon={<Search size={48} />}
          title="No research generated yet"
          description="Click the generate button above to start researching your topic. Serper will gather organic results, People Also Ask, related searches, and knowledge graph data."
          actionLabel="Generate Research"
          onAction={handleGenerate}
        />
      )}

      {items.length > 0 && (
        <div className="flex gap-6">
          <div className="w-[220px] shrink-0 space-y-0.5">
            {sections.map((section) => {
              const Icon = section.icon;
              const count = items.filter((s) => s.category === section.type).length;
              return (
                <button
                  key={section.type}
                  onClick={() => setActiveSection(section.type)}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-[10px] text-[13px] font-medium transition-all duration-150 ${
                    activeSection === section.type
                      ? "bg-accent-primary/10 text-accent-primary"
                      : "text-text-secondary hover:text-text-primary hover:bg-[rgba(255,255,255,0.04)]"
                  }`}
                >
                  <Icon size={16} />
                  <span className="flex-1 text-left">{section.label}</span>
                  <span className="text-[11px] opacity-60">{count}</span>
                </button>
              );
            })}
          </div>

          <div className="flex-1 min-w-0">
            {filteredSources.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <p className="text-[14px] text-text-secondary">
                  No sources in this category. Try another filter.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-4">
                {filteredSources.map((source) => (
                  <Card key={source.id} hover padding="md">
                    <div className="flex items-start justify-between gap-3 mb-2">
                      <div className="min-w-0 flex-1">
                        <h3 className="text-[15px] font-semibold text-text-primary leading-snug">
                          {source.title}
                        </h3>
                      </div>
                      <div className="flex items-center gap-0.5 shrink-0">
                        <button
                          onClick={() => togglePin(source.id)}
                          className={`p-1 rounded-md transition-colors ${
                            pinnedSources.has(source.id)
                              ? "text-accent-warning"
                              : "text-text-secondary/40 hover:text-text-secondary"
                          }`}
                        >
                          <Pin size={14} />
                        </button>
                      </div>
                    </div>

                    <p className="text-[13px] text-text-secondary leading-relaxed mb-3 line-clamp-2">
                      {source.snippet}
                    </p>

                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        {source.url && (
                          <span className="text-[11px] text-text-secondary flex items-center gap-1 truncate max-w-[140px]">
                            <Globe size={10} />
                            {source.url.replace(/^https?:\/\//, "").split("/")[0]}
                          </span>
                        )}
                        <Badge variant={typeVariantMap[source.category] || "neutral"}>
                          {source.category}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-1">
                        {source.url && (
                          <a href={source.url} target="_blank" rel="noopener noreferrer">
                            <Button variant="ghost" size="sm" icon={<ExternalLink size={12} />}>
                              Open
                            </Button>
                          </a>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          icon={<Copy size={12} />}
                          onClick={() => handleCopy(source)}
                        >
                          {copiedId === source.id ? "Copied!" : "Copy"}
                        </Button>
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
