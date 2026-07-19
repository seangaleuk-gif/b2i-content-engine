"use client";

import { useState, useCallback } from "react";
import { useParams } from "next/navigation";
import {
  Send,
  Globe,
  CheckCircle2,
  Circle,
  Lock,
  Loader2,
  FileText,
  ExternalLink,
} from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { useData } from "@/lib/use-data";
import { api } from "@/lib/api-client";

interface Project {
  id: number;
  name: string;
  status: string;
  content: string;
}

interface SeoCheck {
  id: number;
  status: string;
}

interface ImageItem {
  id: number;
  status: string;
}

interface SocialPost {
  id: number;
  status: string;
}

interface ChecklistItem {
  id: string;
  label: string;
  condition: boolean;
}

interface BlogVersion {
  id: number;
  title: string;
  metaDescription: string;
  slug: string;
}

function PublishSkeleton() {
  return (
    <div className="max-w-[1400px] mx-auto px-10 py-8">
      <div className="flex items-center justify-between mb-10">
        <div>
          <Skeleton variant="text" width={180} height={38} />
          <Skeleton variant="text" width={250} className="mt-1" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-6">
        <Skeleton variant="rectangular" height={380} />
        <Skeleton variant="rectangular" height={380} />
      </div>
    </div>
  );
}

export default function PublishPage() {
  const params = useParams();
  const projectId = params.id as string;

  const { data: project, loading: projectLoading } = useData<Project>(
    () => api.get(`/api/projects/${projectId}`)
  );

  const { data: seoItems, loading: seoLoading } = useData<SeoCheck[]>(
    () => api.get(`/api/projects/${projectId}/seo`)
  );

  const { data: imageItems, loading: imagesLoading } = useData<ImageItem[]>(
    () => api.get(`/api/projects/${projectId}/images`)
  );

  const { data: socialItems, loading: socialLoading } = useData<SocialPost[]>(
    () => api.get(`/api/projects/${projectId}/social`)
  );

  const { data: blogVersions } = useData<BlogVersion[]>(
    () => api.get(`/api/projects/${projectId}/versions`)
  );
  const latestEn = (blogVersions ?? []).find((v: BlogVersion) => !v.slug?.endsWith("-zh"));
  const latestZh = (blogVersions ?? []).find((v: BlogVersion) => v.slug?.endsWith("-zh"));

  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [publishResult, setPublishResult] = useState<{ en?: { url: string }; zh?: { url: string } } | null>(null);

  const handlePublish = useCallback(async (status: "publish" | "draft") => {
    setPublishing(true);
    setPublishError(null);
    setPublishResult(null);
    try {
      const result = await api.post<{ wp: { en?: { url: string }; zh?: { url: string } } }>("/api/publish-blog", { projectId: Number(projectId), status });
      setPublishResult(result.wp);
      if (status === "publish") {
        window.location.reload();
      }
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : "Publish failed");
    } finally {
      setPublishing(false);
    }
  }, [projectId]);

  const loading =
    projectLoading || seoLoading || imagesLoading || socialLoading;

  if (loading) return <PublishSkeleton />;

  if (!project) {
    return (
      <div className="max-w-[1400px] mx-auto px-10 py-8">
        <EmptyState
          icon={<FileText size={48} />}
          title="Project not found"
          description="This project may have been deleted or you don't have access to it."
        />
      </div>
    );
  }

  const hasContent = (project?.content?.length ?? 0) > 0;
  const seoChecksExist = (seoItems?.length ?? 0) > 0;
  const imagesExist = (imageItems?.length ?? 0) > 0;
  const socialPostsExist = (socialItems?.length ?? 0) > 0;
  const metaDescriptionSet = !!(latestEn?.metaDescription);

  const checklistItems: ChecklistItem[] = [
    {
      id: "blog",
      label: "Blog generated",
      condition: hasContent,
    },
    {
      id: "seo",
      label: "SEO audit passed",
      condition: seoChecksExist,
    },
    {
      id: "images",
      label: "Images generated",
      condition: imagesExist,
    },
    {
      id: "social",
      label: "Social posts ready",
      condition: socialPostsExist,
    },
    {
      id: "meta",
      label: "Meta description set",
      condition: metaDescriptionSet,
    },
  ];

  const completedCount = checklistItems.filter((i) => i.condition).length;
  const allComplete = completedCount === checklistItems.length;

  return (
    <div className="max-w-[1400px] mx-auto px-10 py-8">
      <div className="flex items-center justify-between mb-10">
        <div>
          <h1 className="text-[38px] font-bold text-text-primary tracking-tight">
            Publish
          </h1>
          <p className="text-[14px] text-text-secondary mt-1">
            Publish your content
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[13px] text-text-secondary">
            {completedCount}/{checklistItems.length} complete
          </span>
          {allComplete && (
            <span className="text-[13px] text-accent-green flex items-center gap-1.5 font-medium">
              <CheckCircle2 size={14} />
              Ready to publish
            </span>
          )}
        </div>
      </div>

      {completedCount === 0 ? (
        <EmptyState
          icon={<Send size={48} />}
          title="Complete all checklist items before publishing"
          description="Generate your blog, run an SEO audit, create images, and prepare social posts. Then you'll be ready to publish."
        />
      ) : (
        <div className="grid grid-cols-2 gap-6">
          <Card padding="lg">
            <h3 className="text-[16px] font-semibold text-text-primary mb-5 flex items-center gap-2">
              <CheckCircle2 size={18} className="text-accent-green" />
              Publishing Checklist
            </h3>
            <div className="space-y-3">
              {checklistItems.map((item) => (
                <div
                  key={item.id}
                  className={`flex items-center gap-3 px-4 py-3 rounded-[10px] transition-all ${
                    item.condition
                      ? "bg-accent-green/5 border border-accent-green/15"
                      : "bg-bg-surface-secondary border border-border-subtle"
                  }`}
                >
                  {item.condition ? (
                    <CheckCircle2
                      size={18}
                      className="text-accent-green shrink-0"
                    />
                  ) : (
                    <Circle
                      size={18}
                      className="text-text-secondary/30 shrink-0"
                    />
                  )}
                  <span
                    className={`text-[14px] ${
                      item.condition
                        ? "text-text-primary font-medium"
                        : "text-text-secondary"
                    }`}
                  >
                    {item.label}
                  </span>
                </div>
              ))}
            </div>
          </Card>

          <Card padding="lg">
            <h3 className="text-[16px] font-semibold text-text-primary mb-5 flex items-center gap-2">
              <Globe size={18} className="text-text-secondary" />
              Publish to WordPress
            </h3>

            <div className="space-y-4">
              <div className="flex flex-col gap-1.5">
                <label className="text-[13px] font-medium text-text-secondary">
                  WordPress Site URL
                </label>
                <div className="flex items-center gap-2">
                  <input
                    disabled
                    placeholder="https://yoursite.com"
                    className="flex-1 bg-bg-surface border border-border-subtle rounded-[10px] px-3.5 py-2.5 text-[14px] text-text-primary placeholder:text-text-secondary/50 disabled:opacity-40 disabled:cursor-not-allowed"
                  />
                  <Lock size={14} className="text-text-secondary/40 shrink-0" />
                </div>
              </div>

              <div className="flex items-center gap-2 px-3 py-2 bg-bg-surface-secondary rounded-[10px]">
                <div
                  className={`w-2.5 h-2.5 rounded-full ${
                    project?.status === "published"
                      ? "bg-accent-green"
                      : "bg-accent-warning"
                  }`}
                />
                <span className="text-[13px] text-text-secondary">
                  Status:{" "}
                  <span className="text-text-primary font-medium capitalize">
                    {project?.status ?? "draft"}
                  </span>
                </span>
              </div>

              {latestEn?.metaDescription && (
                <div className="p-3 bg-bg-surface-secondary rounded-[10px] border border-border-subtle">
                  <p className="text-[11px] font-medium text-text-secondary uppercase tracking-wider mb-1">Meta Description (EN)</p>
                  <p className="text-[13px] text-text-primary leading-relaxed">{latestEn.metaDescription}</p>
                  <p className="text-[11px] text-text-secondary mt-1">{latestEn.metaDescription.length} chars</p>
                </div>
              )}
              {latestZh?.metaDescription && (
                <div className="p-3 bg-bg-surface-secondary rounded-[10px] border border-border-subtle">
                  <p className="text-[11px] font-medium text-text-secondary uppercase tracking-wider mb-1">Meta Description (ZH)</p>
                  <p className="text-[13px] text-text-primary leading-relaxed">{latestZh.metaDescription}</p>
                  <p className="text-[11px] text-text-secondary mt-1">{latestZh.metaDescription.length} chars</p>
                </div>
              )}

              <Button
                className="w-full mb-2"
                onClick={() => handlePublish("publish")}
                disabled={publishing}
                icon={publishing ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              >
                Publish Now
              </Button>
              <Button
                className="w-full"
                variant="secondary"
                onClick={() => handlePublish("draft")}
                disabled={publishing}
              >
                Save as Draft
              </Button>

              {publishError && (
                <p className="text-[13px] text-accent-danger mt-2">{publishError}</p>
              )}

              {publishResult && (
                <div className="mt-3 space-y-1">
                  {publishResult.en?.url && (
                    <a href={publishResult.en.url} target="_blank" rel="noopener noreferrer" className="text-[13px] text-accent-primary hover:underline flex items-center gap-1">
                      <ExternalLink size={12} /> View EN Post
                    </a>
                  )}
                  {publishResult.zh?.url && (
                    <a href={publishResult.zh.url} target="_blank" rel="noopener noreferrer" className="text-[13px] text-accent-primary hover:underline flex items-center gap-1">
                      <ExternalLink size={12} /> View ZH Post
                    </a>
                  )}
                </div>
              )}
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
