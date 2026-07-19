"use client";

import { useState, useCallback } from "react";
import { useParams } from "next/navigation";
import {
  Languages,
  Globe,
  Sparkles,
  Loader2,
  CheckCircle2,
  Hash,
  Clock,
  FileText,
} from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { useData } from "@/lib/use-data";
import { api } from "@/lib/api-client";

interface BlogVersion {
  id: number;
  versionNumber: number;
  title: string;
  blog: string;
  slug: string;
  wordCount: number;
  createdAt: string;
}

function TranslationSkeleton() {
  return (
    <div className="max-w-[1400px] mx-auto px-10 py-8">
      <Skeleton variant="text" width={220} height={38} />
      <Skeleton variant="text" width={350} className="mt-1 mb-10" />
      <Skeleton variant="rectangular" height={400} />
    </div>
  );
}

export default function TranslationPage() {
  const params = useParams();
  const projectId = params.id as string;
  const [translating, setTranslating] = useState(false);
  const [transError, setTransError] = useState<string | null>(null);
  const [transSuccess, setTransSuccess] = useState(false);

  const { data: versions, loading, refetch } = useData<BlogVersion[]>(() =>
    api.get(`/api/projects/${projectId}/versions`)
  );

  const handleTranslate = useCallback(async () => {
    setTranslating(true);
    setTransError(null);
    setTransSuccess(false);
    try {
      await api.post<unknown>(`/api/projects/${projectId}/translate`, {});
      await refetch();
      setTransSuccess(true);
      setTimeout(() => setTransSuccess(false), 4000);
    } catch (err) {
      setTransError(err instanceof Error ? err.message : "Translation failed");
    } finally {
      setTranslating(false);
    }
  }, [projectId, refetch]);

  if (loading) return <TranslationSkeleton />;

  const items = versions ?? [];
  const sorted = items.sort((a, b) => b.versionNumber - a.versionNumber);
  const englishVersion = sorted.filter((v) => !v.slug?.endsWith("-zh"))[0];
  const chineseVersion = sorted.filter((v) => v.slug?.endsWith("-zh"))[0];
  const displayVersions = [englishVersion, chineseVersion].filter(Boolean);
  const hasEnglish = !!englishVersion;

  return (
    <div className="h-full flex flex-col px-10 py-8 overflow-hidden">
      <div className="shrink-0 flex items-center justify-between mb-10">
        <div>
          <h1 className="text-[38px] font-bold text-text-primary tracking-tight">
            Translation
          </h1>
            <p className="text-[14px] text-text-secondary mt-1">              {chineseVersion ? "Traditional Chinese translation available" : "Translate to Traditional Chinese (Hong Kong)"}
            </p>
        </div>
        <Button
          icon={translating ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
          onClick={handleTranslate}
          disabled={translating || !hasEnglish}
        >
          {translating ? "Translating..." : "Generate Chinese Version"}
        </Button>
      </div>

      {transError && (
        <div className="mb-6 p-4 bg-accent-danger/10 border border-accent-danger/30 rounded-[12px] flex items-start gap-3">
          <CheckCircle2 size={18} className="text-accent-danger shrink-0 mt-0.5" />
          <p className="text-[14px] text-text-secondary">{transError}</p>
        </div>
      )}

      {transSuccess && (
        <div className="mb-6 p-4 bg-accent-green/10 border border-accent-green/30 rounded-[12px] flex items-start gap-3">
          <CheckCircle2 size={18} className="text-accent-green shrink-0 mt-0.5" />
          <p className="text-[14px] font-medium text-accent-green">Translation complete</p>
        </div>
      )}

      {!hasEnglish ? (
        <EmptyState
          icon={<FileText size={48} />}
          title="No blog to translate"
          description="Generate a blog post first, then come back to translate it."
        />
      ) : (
        <div className="grid grid-cols-2 gap-6 flex-1 min-h-0">
          {displayVersions.map((v) => {
            const isChinese = v.slug?.endsWith("-zh");
            return (
              <Card key={v.id} padding="lg" className="flex flex-col min-h-0">
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-10 h-10 rounded-[10px] bg-bg-surface-secondary flex items-center justify-center text-text-secondary">
                    {isChinese ? <span className="text-[16px]">中</span> : <Globe size={20} />}
                  </div>
                  <div>
                    <h3 className="text-[16px] font-semibold text-text-primary">
                      {v.title || "Untitled"}
                    </h3>
                    <p className="text-[12px] text-text-secondary">
                      {isChinese ? "繁體中文" : "English"} · v{v.versionNumber}
                    </p>
                  </div>
                  {isChinese && (
                    <Badge variant="research">繁體中文</Badge>
                  )}
                </div>
                <div className="flex items-center gap-4 text-[12px] text-text-secondary mb-3">
                  <span className="flex items-center gap-1"><Hash size={12} />{v.wordCount.toLocaleString()} words</span>
                  {v.slug && (
                    <span className="flex items-center gap-1"><Globe size={12} />{v.slug}</span>
                  )}
                </div>
                <div className="bg-bg-surface-secondary rounded-[10px] p-4 text-[13px] text-text-secondary flex-1 min-h-0 overflow-y-auto whitespace-pre-wrap leading-relaxed">
                  {(v.blog ?? "").replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, "")}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
