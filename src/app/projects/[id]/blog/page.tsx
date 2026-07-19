"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Clock, Hash, Eye, FileText, ExternalLink, Sparkles, Loader2, Tag, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { useData } from "@/lib/use-data";
import { api } from "@/lib/api-client";
import { formatDate } from "@/lib/utils";

interface BlogVersion {
  id: number;
  versionNumber: number;
  title: string;
  slug: string;
  metaDescription: string;
  excerpt: string;
  blog: string;
  faq: { question: string; answer: string }[];
  internalLinks: string[];
  externalLinks: string[];
  categories: string[];
  tags: string[];
  readingTime: string;
  wordCount: number;
  summary: string;
  model: string;
  createdAt: string;
}

interface Project {
  id: number;
  name: string;
  keyword: string;
  status: string;
}

function BlogSkeleton() {
  return (
    <div className="max-w-[900px] mx-auto px-10 py-8">
      <Skeleton variant="text" width={300} height={38} className="mb-2" />
      <Skeleton variant="text" width={200} className="mb-6" />
      <Skeleton variant="rectangular" height={300} className="mb-4" />
      <Skeleton variant="rectangular" height={200} />
    </div>
  );
}

export default function BlogViewPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const projectId = params.id as string;
  const activeTag = searchParams.get("tag");

  const { data: versions, loading, refetch: refetchVersions } = useData<BlogVersion[]>(() =>
    api.get(`/api/projects/${projectId}/versions`)
  );

  const { data: project, refetch: refetchProject } = useData<Project>(() =>
    api.get(`/api/projects/${projectId}`)
  );

  const [lang, setLang] = useState<"en" | "zh">("en");
  const [generating, setGenerating] = useState(false);
  const router = useRouter();

  const refreshData = useCallback(async () => {
    await Promise.all([refetchVersions(), refetchProject()]);
  }, [refetchVersions, refetchProject]);

  useEffect(() => {
    refreshData();
  }, [refreshData]);

  const handleGenerate = useCallback(async () => {
    setGenerating(true);
    try {
      await api.post<unknown>(`/api/generate-blog`, { projectId: Number(projectId) });
      await refreshData();
      setGenerating(false);
    } catch {
      setGenerating(false);
    }
  }, [projectId, refreshData]);

  if (loading) return <BlogSkeleton />;

  const sorted = (versions ?? []).sort((a, b) => b.versionNumber - a.versionNumber);
  const englishVersions = sorted.filter((v) => !v.slug?.endsWith("-zh"));
  const chineseVersions = sorted.filter((v) => v.slug?.endsWith("-zh"));

  const filteredEnglish = activeTag
    ? englishVersions.filter((v) => v.tags?.some((t) => t.toLowerCase() === activeTag.toLowerCase()))
    : englishVersions;
  const filteredChinese = activeTag
    ? chineseVersions.filter((v) => v.tags?.some((t) => t.toLowerCase() === activeTag.toLowerCase()))
    : chineseVersions;

  const latest = lang === "en" ? filteredEnglish[0] : filteredChinese[0] || filteredEnglish[0];

  const clearTag = () => {
    const newUrl = window.location.pathname;
    router.replace(newUrl);
  };

  if (!latest || !latest.blog) {
    return (
      <div className="max-w-[900px] mx-auto px-10 py-8">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-[38px] font-bold text-text-primary tracking-tight">Blog</h1>
          <div className="flex items-center gap-2">
            {activeTag && (
              <div className="flex items-center gap-2 px-3 py-1.5 bg-accent-primary/10 border border-accent-primary/20 rounded-[8px]">
                <Tag size={14} className="text-accent-primary" />
                <span className="text-[13px] font-medium text-accent-primary">{activeTag}</span>
                <button onClick={clearTag} className="text-accent-primary hover:text-accent-primary/70 cursor-pointer">
                  <X size={14} />
                </button>
              </div>
            )}
            <Button
              icon={generating ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
              onClick={handleGenerate}
              disabled={generating}
            >
              {generating ? "Generating..." : "Generate Blog"}
            </Button>
          </div>
        </div>
        {activeTag ? (
          <EmptyState
            icon={<Tag size={48} />}
            title={`No posts found for "${activeTag}"`}
            description={`No blog versions match the tag "${activeTag}". Try a different tag or clear the filter.`}
          />
        ) : (
          <EmptyState
            icon={<FileText size={48} />}
            title="No blog generated yet"
            description="Generate a blog from the workspace editor first. Then come back here to view the published version."
          />
        )}
      </div>
    );
  }

  const blogContent = latest.blog
    .replace(/<!-- \/?wp:[^>]+ -->/g, "")
    .replace(/<!-- \/?wp:html -->/g, "");
  const wordCount = blogContent.replace(/<[^>]+>/g, "").split(/\s+/).filter(Boolean).length;

  return (
    <div className="max-w-[900px] mx-auto px-10 py-8">
        <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-[38px] font-bold text-text-primary tracking-tight leading-tight">
            Blog
          </h1>
          {latest && <p className="text-[14px] text-text-secondary mt-1">Version {latest.versionNumber}</p>}
        </div>
        <div className="flex items-center gap-2">
          {activeTag && (
            <div className="flex items-center gap-2 px-3 py-1.5 bg-accent-primary/10 border border-accent-primary/20 rounded-[8px]">
              <Tag size={14} className="text-accent-primary" />
              <span className="text-[13px] font-medium text-accent-primary">{activeTag}</span>
              <button onClick={clearTag} className="text-accent-primary hover:text-accent-primary/70 cursor-pointer">
                <X size={14} />
              </button>
            </div>
          )}
          <Button
            icon={generating ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
            onClick={handleGenerate}
            disabled={generating}
          >
            {generating ? "Generating..." : "Generate Blog"}
          </Button>
        </div>
      </div>

      <div className="mb-10">
        <div className="flex items-center gap-3 mb-2">
          <Badge variant="success">v{latest.versionNumber}</Badge>
          {latest.model && <Badge variant="neutral">{latest.model}</Badge>}
        </div>
        {(englishVersions.length > 0 && chineseVersions.length > 0) && (
          <div className="flex items-center gap-2 mb-4">
            <button
              onClick={() => setLang("en")}
              className={`px-3 py-1.5 rounded-[8px] text-[13px] font-medium transition-all ${lang === "en" ? "bg-accent-primary/10 text-accent-primary" : "text-text-secondary hover:text-text-primary"}`}
            >
              EN
            </button>
            <button
              onClick={() => setLang("zh")}
              className={`px-3 py-1.5 rounded-[8px] text-[13px] font-medium transition-all ${lang === "zh" ? "bg-accent-primary/10 text-accent-primary" : "text-text-secondary hover:text-text-primary"}`}
            >
              中文
            </button>
          </div>
        )}
        <h1 className="text-[38px] font-bold text-text-primary tracking-tight leading-tight mb-3">
          {latest.title || project?.name || "Untitled"}
        </h1>
        {latest.metaDescription && (
          <p className="text-[15px] text-text-secondary leading-relaxed mb-4">
            {latest.metaDescription}
          </p>
        )}
        <div className="flex items-center gap-5 text-[13px] text-text-secondary">
          <span className="flex items-center gap-1.5">
            <Clock size={14} />
            {latest.readingTime || `${Math.max(1, Math.ceil(wordCount / 200))} min read`}
          </span>
          <span className="flex items-center gap-1.5">
            <Hash size={14} />
            {wordCount.toLocaleString()} words
          </span>
          <span className="flex items-center gap-1.5">
            <Eye size={14} />
            Generated {formatDate(latest.createdAt)}
          </span>
        </div>
      </div>

      {latest.categories && latest.categories.length > 0 && (
        <div className="flex items-center gap-2 mb-8">
          {latest.categories.map((cat) => (
            <Badge key={cat} variant="research">{cat}</Badge>
          ))}
        </div>
      )}

      <article className="prose prose-invert max-w-none">
        <div
          className="text-[16px] leading-relaxed text-text-primary space-y-4"
          dangerouslySetInnerHTML={{ __html: blogContent }}
        />
      </article>

      {latest.tags && latest.tags.length > 0 && (
        <div className="mt-10 pt-6 border-t border-border-subtle">
          <h3 className="text-[14px] font-semibold text-text-secondary mb-3">Tags</h3>
          <div className="flex flex-wrap gap-2">
            {latest.tags.map((tag) => {
              const tagBase = lang === "zh" ? "https://b2ihub.com/blog/zh/tag" : "https://b2ihub.com/blog/tag";
              return (
                <a
                  key={tag}
                  href={`${tagBase}/${encodeURIComponent(tag)}/`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Badge variant="neutral">{tag}</Badge>
                </a>
              );
            })}
          </div>
        </div>
      )}

      {latest.faq && latest.faq.length > 0 && (
        <div className="mt-10">
          <h2 className="text-[22px] font-bold text-text-primary mb-6">FAQ</h2>
          <div className="space-y-5">
            {latest.faq.map((item, i) => (
              <Card key={i} padding="md">
                <h3 className="text-[15px] font-semibold text-text-primary mb-2">{item.question}</h3>
                <p className="text-[14px] text-text-secondary leading-relaxed">{item.answer}</p>
              </Card>
            ))}
          </div>
        </div>
      )}

      {(latest.internalLinks?.length > 0 || latest.externalLinks?.length > 0) && (
        <div className="mt-10 grid grid-cols-2 gap-6">
          {latest.internalLinks?.length > 0 && (
            <div>
              <h3 className="text-[14px] font-semibold text-text-secondary mb-3">Internal Links</h3>
              <div className="space-y-1.5">
                {latest.internalLinks.map((link) => (
                  <a key={link} href={link} className="flex items-center gap-2 text-[13px] text-accent-primary hover:underline">
                    <ExternalLink size={12} />
                    {link}
                  </a>
                ))}
              </div>
            </div>
          )}
          {latest.externalLinks?.length > 0 && (
            <div>
              <h3 className="text-[14px] font-semibold text-text-secondary mb-3">External Links</h3>
              <div className="space-y-1.5">
                {latest.externalLinks.map((link) => (
                  <a key={link} href={link} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 text-[13px] text-accent-primary hover:underline">
                    <ExternalLink size={12} />
                    {link}
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
