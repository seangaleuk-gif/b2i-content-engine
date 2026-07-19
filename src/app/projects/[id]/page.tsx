"use client";

import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import {
  CheckCircle2,
  Circle,
  Loader2,
  ChevronRight,
  Search,
  Image,
  Share2,
  Languages,
  Send,
  BarChart3,
  PenLine,
  BookOpen,
  Users,
  Clock,
  Hash,
  Flag,
  Monitor,
  Save,
  Copy,
  Download,
  Sparkles,
  RotateCcw,
  Trash2,
  History,
  Gauge,
  Eye,
} from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { Input } from "@/components/ui/Input";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { useData } from "@/lib/use-data";
import { api } from "@/lib/api-client";

interface Project {
  id: number;
  name: string;
  status: string;
  keyword: string;
  audience: string;
  country: string;
  wordCount: number;
  content: string;
  seoScore: number | null;
}

interface BlogVersion {
  id: number;
  projectId: number;
  versionNumber: number;
  title: string;
  slug: string;
  metaDescription: string;
  blog: string;
  wordCount: number;
  readingTime: string;
  createdAt: string;
}

interface GeneratedBlog {
  success: boolean;
  version: number;
  title: string;
  slug: string;
  metaDescription: string;
  blog: string;
  wordCount: number;
  readingTime: string;
}

interface WorkflowStep {
  id: string;
  label: string;
  icon: React.ReactNode;
  status: "complete" | "in-progress" | "pending";
}

const GENERATE_STEPS = [
  "Loading Project",
  "Loading Research",
  "Loading Knowledge",
  "Building Prompt",
  "Contacting DeepSeek",
  "Generating Article",
  "Saving Article",
  "Complete",
] as const;

const workflowStepDefs: { id: string; label: string; icon: React.ReactNode }[] = [
  { id: "research", label: "Research", icon: <Search size={16} /> },
  { id: "competitor", label: "Competitor Analysis", icon: <BarChart3 size={16} /> },
  { id: "outline", label: "Outline", icon: <BookOpen size={16} /> },
  { id: "blog", label: "Blog", icon: <PenLine size={16} /> },
  { id: "seo", label: "SEO Audit", icon: <Gauge size={16} /> },
  { id: "images", label: "Images", icon: <Image size={16} /> },
  { id: "social", label: "Social", icon: <Share2 size={16} /> },
  { id: "translation", label: "Translation", icon: <Languages size={16} /> },
  { id: "publish", label: "Publish", icon: <Send size={16} /> },
];

function calculateReadingTime(text: string): string {
  const words = text.split(/\s+/).filter(Boolean).length;
  const minutes = Math.max(1, Math.ceil(words / 200));
  return `${minutes} min read`;
}

function calculateWordCount(text: string): number {
  let cleaned = text
    .replace(/<!-- \/?wp:\w+.*?-->/g, "")          // WordPress block comments
    .replace(/<!-- wp:html -->[\s\S]*?<!-- \/wp:html -->/g, "") // Custom HTML blocks
    .replace(/<script[\s\S]*?<\/script>/g, "")      // JSON-LD schema blocks
    .replace(/<[^>]+>/g, "")                        // HTML tags
    .replace(/```[\s\S]*?```/g, "")                  // code blocks
    .replace(/[\[\]\(\)#*_~`>|]/g, " ")             // remaining markdown syntax
    .replace(/\{.*?\}/g, " ")                       // JSON-like objects
    .replace(/\s+/g, " ")
    .trim();
  return cleaned ? cleaned.split(/\s+/).length : 0;
}

function simpleMarkdownToHtml(md: string): string {
  let html = md
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  html = html
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>");
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2" />');
  html = html.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>'
  );
  html = html.replace(/^- (.+)$/gm, "<li>$1</li>");
  html = html.replace(/(<li>.*<\/li>\n?)+/g, "<ul>$&</ul>");
  html = html.replace(/\n\n/g, "</p><p>");
  html = "<p>" + html + "</p>";
  html = html.replace(/<p><h([1-3])>/g, "<h$1>");
  html = html.replace(/<\/h([1-3])><\/p>/g, "</h$1>");
  html = html.replace(/<p><ul>/g, "<ul>");
  html = html.replace(/<\/ul><\/p>/g, "</ul>");
  return html;
}

function WorkspaceSkeleton() {
  return (
    <div className="flex h-full">
      <div className="w-[240px] shrink-0 border-r border-border-subtle bg-bg-surface p-5">
        <Skeleton variant="text" width={100} />
        <Skeleton variant="rectangular" height={8} className="mt-3" />
        <Skeleton variant="text" width={80} className="mt-1.5" />
        <div className="mt-4 space-y-0.5">
          {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => (
            <Skeleton key={i} variant="rectangular" height={36} />
          ))}
        </div>
      </div>
      <div className="flex-1 flex items-center justify-center">
        <Skeleton variant="rectangular" width={600} height={400} />
      </div>
      <div className="w-[320px] shrink-0 border-l border-border-subtle bg-bg-surface p-5 space-y-5">
        <Skeleton variant="rectangular" height={200} />
        <Skeleton variant="rectangular" height={150} />
        <Skeleton variant="rectangular" height={200} />
      </div>
    </div>
  );
}

export default function ProjectWorkspacePage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();
  const projectId = params.id as string;

  const [content, setContent] = useState("");
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [copied, setCopied] = useState(false);
  const [preview, setPreview] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [currentStep, setCurrentStep] = useState(-1);
  const [generatedData, setGeneratedData] = useState<GeneratedBlog | null>(null);
  const [currentVersion, setCurrentVersion] = useState<number | null>(
    searchParams.get("version") ? Number(searchParams.get("version")) : null
  );
  const [seoTitle, setSeoTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [metaDescription, setMetaDescription] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [versionsOpen, setVersionsOpen] = useState(false);

  const dirtyRef = useRef(false);
  const contentRef = useRef(content);

  useEffect(() => {
    contentRef.current = content;
  }, [content]);

  useEffect(() => {
    if (currentVersion) {
      const url = new URL(window.location.href);
      url.searchParams.set("version", String(currentVersion));
      window.history.replaceState({}, "", url.toString());
    }
  }, [currentVersion]);

  const {
    data: project,
    loading,
    refetch,
  } = useData<Project>(() => api.get(`/api/projects/${projectId}`));

  useEffect(() => {
    if (project && !dirtyRef.current && project.content) {
      setContent(project.content);
    }
  }, [project]);

  const {
    data: versions,
    loading: versionsLoading,
    refetch: refetchVersions,
  } = useData<BlogVersion[]>(() => api.get(`/api/projects/${projectId}/versions`));

  useEffect(() => {
    if (versions && versions.length > 0 && !generatedData) {
      const latest = versions[0];
      if (latest.title && !seoTitle) setSeoTitle(latest.title);
      if (latest.slug && !slug) setSlug(latest.slug);
      if (latest.metaDescription && !metaDescription) setMetaDescription(latest.metaDescription);
    }
  }, [versions]);

  const { data: researchItems } = useData<unknown[]>(() =>
    api.get(`/api/projects/${projectId}/research`)
  );
  const { data: seoItems } = useData<unknown[]>(() =>
    api.get(`/api/projects/${projectId}/seo`)
  );
  const { data: imageItems } = useData<unknown[]>(() =>
    api.get(`/api/projects/${projectId}/images`)
  );
  const { data: socialItems } = useData<unknown[]>(() =>
    api.get(`/api/projects/${projectId}/social`)
  );

  const workflowSteps: WorkflowStep[] = useMemo(() => {
    const researchDone = (researchItems?.length ?? 0) > 0;
    const blogDone = (versions?.length ?? 0) > 0 || (project?.content?.length ?? 0) > 100;
    const outlineDone = blogDone || (project?.wordCount ?? 0) > 0;
    const seoDone = (seoItems?.length ?? 0) > 0;
    const imagesDone = (imageItems?.length ?? 0) > 0;
    const socialDone = (socialItems?.length ?? 0) > 0;

    const statuses: Record<string, WorkflowStep["status"]> = {
      research: researchDone ? "complete" : "in-progress",
      competitor: researchDone ? "complete" : "pending",
      outline: outlineDone ? "complete" : researchDone ? "in-progress" : "pending",
      blog: blogDone ? "complete" : outlineDone ? "in-progress" : "pending",
      seo: seoDone ? "complete" : blogDone ? "in-progress" : "pending",
      images: imagesDone ? "complete" : blogDone ? "in-progress" : "pending",
      social: socialDone ? "complete" : blogDone ? "in-progress" : "pending",
      translation: "pending",
      publish: project?.status === "published" ? "complete" : blogDone ? "in-progress" : "pending",
    };

    return workflowStepDefs.map((def) => ({
      ...def,
      status: statuses[def.id] || "pending",
    }));
  }, [researchItems, seoItems, imageItems, socialItems, versions, project]);

  const doSave = useCallback(async () => {
    setSaveStatus("saving");
    try {
      await api.patch(`/api/projects/${projectId}`, {
        content: contentRef.current || "",
      });
      setSaveStatus("saved");
      dirtyRef.current = false;
      setTimeout(() => setSaveStatus("idle"), 2000);
    } catch {
      setSaveStatus("idle");
    }
  }, [projectId]);

  useEffect(() => {
    const interval = setInterval(() => {
      if (dirtyRef.current && saveStatus !== "saving") {
        doSave();
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [doSave, saveStatus]);

  const handleContentChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setContent(e.target.value);
      dirtyRef.current = true;
      setSaveStatus("idle");
    },
    []
  );

  const handleSave = useCallback(async () => {
    await doSave();
  }, [doSave]);

  const handleCopy = useCallback(() => {
    const text = content || "";
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [content]);

  const handleDownload = useCallback(() => {
    const text = content || "";
    const blob = new Blob([text], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${project?.name ?? "blog"}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }, [content, project]);

  const [deletingProject, setDeletingProject] = useState(false);

  const handleDeleteProject = useCallback(async () => {
    if (!project) return;
    if (!confirm(`Delete "${project.name}"? This cannot be undone.`)) return;
    setDeletingProject(true);
    await api.delete(`/api/projects/${projectId}`);
    router.replace("/projects");
  }, [project, projectId, router]);

  const handleGenerate = useCallback(async () => {
    setGenerating(true);
    setCurrentStep(0);
    setErrorMessage(null);

    let stepIndex = 0;

    const stepInterval = setInterval(() => {
      stepIndex++;
      if (stepIndex < GENERATE_STEPS.length - 1) {
        setCurrentStep(stepIndex);
      }
    }, 300);

    try {
      const result = await api.post<GeneratedBlog>("/api/generate-blog", {
        projectId: Number(projectId),
      });

      clearInterval(stepInterval);
      setCurrentStep(GENERATE_STEPS.length - 1);
      setGeneratedData(result);
      setCurrentVersion(result.version);

      setContent(result.blog);
      dirtyRef.current = false;

      if (result.title) setSeoTitle(result.title);
      if (result.slug) setSlug(result.slug);
      if (result.metaDescription) setMetaDescription(result.metaDescription);

      await refetch();
      await refetchVersions();

      try {
        await api.delete(`/api/projects/${projectId}/seo/audit`);
      } catch { /* no previous audit to clear */ }

      setTimeout(() => {
        setGenerating(false);
        setCurrentStep(-1);
      }, 800);
    } catch (err) {
      clearInterval(stepInterval);
      setGenerating(false);
      setCurrentStep(-1);
      setErrorMessage(
        err instanceof Error ? err.message : "Failed to generate blog"
      );
    }
  }, [projectId, refetch, refetchVersions]);

  const handleRestoreVersion = useCallback(
    async (version: BlogVersion) => {
      setContent(version.blog);
      dirtyRef.current = true;
      setSaveStatus("idle");
      setCurrentVersion(version.versionNumber);
      setGeneratedData(null);
      if (version.title) setSeoTitle(version.title);
      if (version.slug) setSlug(version.slug);
      if (version.metaDescription) setMetaDescription(version.metaDescription);

      try {
        await api.delete(`/api/projects/${projectId}/seo/audit`);
      } catch { /* audit may not exist */ }
    },
    [projectId]
  );

  const handleDeleteVersion = useCallback(
    async (versionId: number) => {
      await fetch(`/api/projects/${projectId}/versions`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ versionId }),
      });
      await refetchVersions();
    },
    [projectId, refetchVersions]
  );

  const handleSeoSave = useCallback(async () => {
    try {
      await api.patch(`/api/projects/${projectId}`, {
        content: contentRef.current,
      });
    } catch {
      // silently fail
    }
  }, [projectId]);

  if (loading) return <WorkspaceSkeleton />;

  if (!project) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-text-secondary">Project not found.</p>
      </div>
    );
  }

  const displayContent = content || "";
  const wordCount = calculateWordCount(displayContent);
  const readingTime = calculateReadingTime(displayContent);
  const hasNoBlog = !displayContent && !project.content;

  const displayVersion = currentVersion ?? (versions && versions.length > 0 ? versions[0].versionNumber : null);

  const completedCount = workflowSteps.filter((s) => s.status === "complete").length;
  const progressPercent = Math.round((completedCount / workflowSteps.length) * 100);

  return (
    <div className="flex h-full">
      {/* Main content area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Toolbar */}
        <div className="flex items-center justify-between px-6 py-3 border-b border-border-subtle bg-bg-surface">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <span className="text-[15px] font-semibold text-text-primary">{project.name}</span>
              {displayVersion && (
                <Badge variant="success">v{displayVersion}</Badge>
              )}
            </div>
            <div className="w-px h-5 bg-border-subtle" />
            <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              icon={saveStatus === "saving" ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              onClick={handleSave}
              disabled={saveStatus === "saving"}
            >
              {saveStatus === "saving" ? "Saving..." : saveStatus === "saved" ? "Saved just now" : "Save"}
            </Button>
            <Button variant="ghost" size="sm" icon={<Copy size={14} />} onClick={handleCopy}>
              {copied ? "Copied!" : "Copy"}
            </Button>
            <Button variant="ghost" size="sm" icon={preview ? <Eye size={14} /> : <Monitor size={14} />} onClick={() => setPreview(!preview)}>
              {preview ? "Edit" : "Preview"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              icon={generating ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}
              onClick={handleGenerate}
              disabled={generating}
            >
              {generating ? "Regenerating..." : "Regenerate"}
            </Button>
            <Button variant="ghost" size="sm" icon={<Download size={14} />} onClick={handleDownload}>
              Download
            </Button>
            <Button
              variant="ghost"
              size="sm"
              icon={deletingProject ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
              onClick={handleDeleteProject}
              disabled={deletingProject}
            />
          </div>
          </div>
          <div className="flex items-center gap-4">
            <Button
              variant="primary"
              size="sm"
              icon={generating ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
              onClick={handleGenerate}
              disabled={generating}
            >
              Generate Blog
            </Button>
            <span className="text-[13px] text-text-secondary flex items-center gap-1.5">
              <Gauge size={14} className="text-accent-green" />
              SEO Score: {project.seoScore ?? "--"}
            </span>
            <span className="text-[13px] text-text-secondary flex items-center gap-1.5">
              <Clock size={14} />
              {readingTime}
            </span>
            <span className="text-[13px] text-text-secondary flex items-center gap-1.5">
              <Hash size={14} />
              {wordCount.toLocaleString()} / {project.wordCount?.toLocaleString() || "?"} words
            </span>
          </div>
        </div>

        {/* Editor / Preview */}
        <div className="flex-1 overflow-y-auto relative">
          {/* Progress overlay */}
          {generating && currentStep >= 0 && (
            <div className="absolute inset-0 z-10 bg-bg-surface/80 backdrop-blur-sm flex items-center justify-center">
              <Card padding="lg" className="w-[420px]">
                <div className="flex items-center gap-3 mb-5">
                  <Loader2 size={20} className="text-accent-primary animate-spin" />
                  <h3 className="text-[16px] font-semibold text-text-primary">Generating Blog</h3>
                </div>
                <div className="space-y-2.5">
                  {GENERATE_STEPS.map((label, i) => {
                    const isComplete = i < currentStep;
                    const isCurrent = i === currentStep;

                    return (
                      <div
                        key={label}
                        className={`flex items-center gap-3 px-3 py-2 rounded-[8px] transition-all ${
                          isCurrent ? "bg-accent-primary/10" : ""
                        }`}
                      >
                        {isComplete ? (
                          <CheckCircle2 size={16} className="text-accent-green shrink-0" />
                        ) : isCurrent ? (
                          <Loader2 size={16} className="text-accent-primary animate-spin shrink-0" />
                        ) : (
                          <Circle size={16} className="text-text-secondary/30 shrink-0" />
                        )}
                        <span
                          className={`text-[14px] ${
                            isComplete
                              ? "text-text-secondary"
                              : isCurrent
                              ? "text-accent-primary font-medium"
                              : "text-text-secondary/50"
                          }`}
                        >
                          {label}
                        </span>
                      </div>
                    );
                  })}
                </div>
                {errorMessage && (
                  <div className="mt-4 p-3 bg-accent-danger/10 rounded-[8px] text-[13px] text-accent-danger">
                    {errorMessage}
                  </div>
                )}
              </Card>
            </div>
          )}

          {hasNoBlog && !generating ? (
            <div className="flex items-center justify-center h-full">
              <EmptyState
                icon={<Sparkles size={48} />}
                title="No blog yet"
                description="No blog has been generated yet. Click Generate Blog to begin."
                actionLabel="Generate Blog"
                onAction={handleGenerate}
              />
            </div>
          ) : (
            <div className="max-w-[800px] mx-auto py-8 px-10">
              {(versions && versions.length > 0) && (
                <div className="flex items-center gap-2 mb-4">
                  <Badge variant="success">v{displayVersion}</Badge>
                  {generatedData && generatedData.version === displayVersion && (
                    <span className="text-[12px] text-accent-green font-medium">— just generated</span>
                  )}
                  <span className="text-[12px] text-text-secondary ml-auto">
                    {versions.length} version{versions.length !== 1 ? "s" : ""} total
                  </span>
                </div>
              )}
              {preview ? (
                <div
                  className="prose prose-invert max-w-none text-text-primary text-[16px] leading-relaxed"
                  dangerouslySetInnerHTML={{
                    __html: simpleMarkdownToHtml(displayContent),
                  }}
                />
              ) : (
                <textarea
                  value={displayContent}
                  onChange={handleContentChange}
                  className="w-full min-h-[600px] bg-transparent text-text-primary text-[16px] leading-relaxed resize-none focus:outline-none font-mono"
                  placeholder="Start writing or generate a blog..."
                />
              )}

              {generatedData && (
                <div className="mt-8 border-t border-border-subtle pt-6 space-y-4">
                  <h3 className="text-[14px] font-semibold text-text-primary flex items-center gap-2">
                    <Gauge size={14} className="text-accent-green" />
                    SEO Metadata
                  </h3>
                  <Input
                    label="SEO Title"
                    value={seoTitle}
                    onChange={(e) => setSeoTitle(e.target.value)}
                    onBlur={handleSeoSave}
                  />
                  <Input
                    label="Slug"
                    value={slug}
                    onChange={(e) => setSlug(e.target.value)}
                    onBlur={handleSeoSave}
                  />
                  <div className="flex flex-col gap-1.5">
                    <label className="text-[13px] font-medium text-text-secondary">
                      Meta Description
                    </label>
                    <textarea
                      className="bg-bg-surface border border-border-subtle rounded-[10px] px-3.5 py-2.5 text-[14px] text-text-primary placeholder:text-text-secondary/50 focus:outline-none focus:border-accent-primary/50 focus:ring-1 focus:ring-accent-primary/20 transition-all resize-none h-20"
                      value={metaDescription}
                      onChange={(e) => setMetaDescription(e.target.value)}
                      onBlur={handleSeoSave}
                    />
                  </div>
                  <div className="flex gap-6">
                    <div className="flex items-center gap-2 text-[13px] text-text-secondary">
                      <Clock size={14} />
                      Reading Time: <span className="font-medium text-text-primary">{generatedData.readingTime}</span>
                    </div>
                    <div className="flex items-center gap-2 text-[13px] text-text-secondary">
                      <Hash size={14} />
                      Word Count: <span className="font-medium text-text-primary">{generatedData.wordCount.toLocaleString()} / {project.wordCount?.toLocaleString() || "?"} words</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Right sidebar area */}
      <div
        className={`shrink-0 border-l border-border-subtle bg-bg-surface overflow-y-auto transition-all duration-200 ${
          versionsOpen ? "w-[620px]" : "w-[320px]"
        }`}
      >
        <div className="p-5 space-y-5">
          {/* Version History */}
          <Card padding="sm">
            <button
              onClick={() => setVersionsOpen(!versionsOpen)}
              className="w-full flex items-center justify-between mb-4"
            >
              <h3 className="text-[16px] font-semibold text-text-primary flex items-center gap-2">
                <History size={16} />
                Version History
              </h3>
              <span className="text-[12px] text-text-secondary">
                {versions?.length ?? 0} versions
              </span>
            </button>

            {versionsOpen ? (
              <div className="space-y-3 max-h-[400px] overflow-y-auto">
                {versionsLoading ? (
                  <div className="space-y-2">
                    {[1, 2, 3].map((i) => (
                      <Skeleton key={i} variant="rectangular" height={72} />
                    ))}
                  </div>
                ) : versions && versions.length > 0 ? (
                  versions.map((v) => (
                    <div
                      key={v.id}
                      className="bg-bg-surface-secondary border border-border-subtle rounded-[10px] p-3"
                    >
                      <div className="flex items-center justify-between mb-1.5">
                        <Badge variant="neutral">v{v.versionNumber}</Badge>
                        <span className="text-[11px] text-text-secondary">
                          {new Date(v.createdAt).toLocaleDateString()}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 text-[12px] text-text-secondary mb-2">
                        <span className="flex items-center gap-1">
                          <Hash size={12} />
                          {(v.wordCount ?? 0).toLocaleString()} words
                        </span>
                        {v.readingTime && (
                          <span className="flex items-center gap-1">
                            <Clock size={12} />
                            {v.readingTime}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() => handleRestoreVersion(v)}
                          className="flex items-center gap-1 px-2 py-1 text-[12px] text-accent-primary hover:bg-accent-primary/10 rounded-[6px] transition-all cursor-pointer"
                        >
                          <RotateCcw size={12} />
                          Restore
                        </button>
                        <button
                          onClick={() => handleDeleteVersion(v.id)}
                          className="flex items-center gap-1 px-2 py-1 text-[12px] text-accent-danger hover:bg-accent-danger/10 rounded-[6px] transition-all cursor-pointer"
                        >
                          <Trash2 size={12} />
                          Delete
                        </button>
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="text-[13px] text-text-secondary/50 text-center py-4">
                    No previous versions
                  </p>
                )}
              </div>
            ) : (
              <p className="text-[13px] text-text-secondary/50">
                Click to expand version history
              </p>
            )}
          </Card>

          {/* Project Context */}
          <Card padding="sm">
            <h3 className="text-[16px] font-semibold text-text-primary mb-4">
              Project Context
            </h3>
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Search size={14} className="text-text-secondary shrink-0" />
                <span className="text-[12px] text-text-secondary">Keyword</span>
                <span className="text-[13px] text-text-primary ml-auto font-medium">
                  {project.keyword || "--"}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Users size={14} className="text-text-secondary shrink-0" />
                <span className="text-[12px] text-text-secondary">Audience</span>
                <span className="text-[13px] text-text-primary ml-auto font-medium">
                  {project.audience || "--"}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Hash size={14} className="text-text-secondary shrink-0" />
                <span className="text-[12px] text-text-secondary">Word Count</span>
                <input
                  type="number"
                  min={500}
                  max={5000}
                  step={100}
                  defaultValue={project.wordCount || 2500}
                  onBlur={async (e) => {
                    const val = Number(e.target.value);
                    if (val >= 500 && val <= 5000) {
                      await api.patch(`/api/projects/${projectId}`, { wordCount: val });
                      refetch();
                    }
                  }}
                  className="text-[13px] text-text-primary font-medium bg-transparent text-right w-16 focus:outline-none focus:border-b focus:border-accent-primary transition-all"
                />
              </div>
              <div className="flex items-center gap-2">
                <Flag size={14} className="text-text-secondary shrink-0" />
                <span className="text-[12px] text-text-secondary">Country</span>
                <span className="text-[13px] text-text-primary ml-auto font-medium">
                  {project.country || "US"}
                </span>
              </div>
            </div>
          </Card>

          {/* SEO Fields */}
          <Card padding="sm">
            <h3 className="text-[16px] font-semibold text-text-primary mb-4">
              SEO Fields
            </h3>
            <div className="space-y-3">
              <Input
                label="SEO Title"
                value={seoTitle}
                onChange={(e) => setSeoTitle(e.target.value)}
              />
              <Input
                label="Slug"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
              />
              <div className="flex flex-col gap-1.5">
                <label className="text-[13px] font-medium text-text-secondary">
                  Meta Description
                </label>
                <textarea
                  className="bg-bg-surface border border-border-subtle rounded-[10px] px-3.5 py-2.5 text-[14px] text-text-primary placeholder:text-text-secondary/50 focus:outline-none focus:border-accent-primary/50 focus:ring-1 focus:ring-accent-primary/20 transition-all resize-none h-20"
                  value={metaDescription}
                  onChange={(e) => setMetaDescription(e.target.value)}
                  placeholder="Write a meta description..."
                />
              </div>
              <Input label="Focus Keyword" defaultValue={project.keyword} />
            </div>
          </Card>

          {/* Project Notes */}
          <Card padding="sm">
            <h3 className="text-[16px] font-semibold text-text-primary mb-3">
              Project Notes
            </h3>
            <textarea
              className="w-full bg-bg-surface-secondary border border-border-subtle rounded-[10px] px-3.5 py-2.5 text-[13px] text-text-primary placeholder:text-text-secondary/50 focus:outline-none focus:border-accent-primary/50 transition-all resize-none h-24"
              placeholder="Add notes..."
            />
          </Card>
        </div>
      </div>
    </div>
  );
}
