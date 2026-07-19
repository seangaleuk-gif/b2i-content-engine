"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import {
  ExternalLink,
  Copy,
  BarChart3,
  Globe,
  Loader2,
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

function CompetitorSkeleton() {
  return (
    <div className="max-w-[1400px] mx-auto px-10 py-8">
      <div className="flex items-center justify-between mb-10">
        <div>
          <Skeleton variant="text" width={280} height={38} />
          <Skeleton variant="text" width={300} className="mt-1" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        {[1, 2, 3, 4].map((i) => (
          <Skeleton key={i} variant="rectangular" height={180} />
        ))}
      </div>
    </div>
  );
}

export default function CompetitorAnalysisPage() {
  const params = useParams();
  const projectId = params.id as string;
  const [copiedId, setCopiedId] = useState<number | null>(null);

  const { data: sources, loading } = useData<ResearchSource[]>(
    () => api.get(`/api/projects/${projectId}/research`),
    []
  );

  const handleCopy = async (source: ResearchSource) => {
    const text = `${source.title}\n${source.url}`;
    await navigator.clipboard.writeText(text);
    setCopiedId(source.id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  if (loading) return <CompetitorSkeleton />;

  const items = sources ?? [];
  const competitors = items.filter((s) => s.category === "competitor");

  return (
    <div className="max-w-[1400px] mx-auto px-10 py-8">
      <div className="flex items-center justify-between mb-10">
        <div>
          <h1 className="text-[38px] font-bold text-text-primary tracking-tight">
            Competitor Analysis
          </h1>
          <p className="text-[14px] text-text-secondary mt-1">
            {competitors.length > 0
              ? `${competitors.length} competitors analyzed`
              : "Analyze competitor content strategies"}
          </p>
        </div>
      </div>

      {competitors.length === 0 ? (
        <EmptyState
          icon={<BarChart3 size={48} />}
          title="No competitor data yet"
          description="Generate research first. Competitor content will appear here automatically when available."
          actionLabel="Go to Research"
          onAction={() => window.history.back()}
        />
      ) : (
        <div className="grid grid-cols-2 gap-4">
          {competitors.map((source) => (
            <Card key={source.id} hover padding="md">
              <div className="flex items-start justify-between gap-3 mb-2">
                <div className="min-w-0 flex-1">
                  <h3 className="text-[15px] font-semibold text-text-primary leading-snug">
                    {source.title}
                  </h3>
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
                  <Badge variant="neutral">competitor</Badge>
                </div>
                <div className="flex items-center gap-1">
                  {source.url && (
                    <a
                      href={source.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={<ExternalLink size={12} />}
                      >
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
  );
}
