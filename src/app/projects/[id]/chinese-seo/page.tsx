"use client";

import { useState, useCallback } from "react";
import { useParams } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle2,
  XCircle,
  ChevronDown,
  ChevronUp,
  Sparkles,
  Languages,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { useData } from "@/lib/use-data";
import { api } from "@/lib/api-client";

interface SeoCheck {
  id: string;
  label: string;
  status: string;
  score: number | null;
  category: string;
  measuredValue?: string;
  targetValue?: string;
  explanation?: string;
}

interface AuditResult {
  overallScore: number;
  checks: SeoCheck[];
  summary: { passed: number; warnings: number; failed: number; notApplicable: number };
  auditedVersionId: number;
  auditedVersionNumber: number;
}

function ZhSeoSkeleton() {
  return (
    <div className="max-w-[1200px] mx-auto px-10 py-8">
      <div className="flex items-center justify-between mb-10">
        <div>
          <Skeleton variant="text" width={200} height={38} />
          <Skeleton variant="text" width={200} className="mt-1" />
        </div>
        <Skeleton variant="rectangular" width={150} height={38} />
      </div>
      <div className="grid grid-cols-4 gap-4 mb-10">
        <Skeleton variant="rectangular" height={200} />
        <div className="col-span-3">
          <Skeleton variant="rectangular" height={200} />
        </div>
      </div>
    </div>
  );
}

export default function ChineseSEOPage() {
  const params = useParams();
  const projectId = params.id as string;
  const [auditing, setAuditing] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [liveAuditResult, setLiveAuditResult] = useState<AuditResult | null>(null);
  const [expandedChecks, setExpandedChecks] = useState<Set<string>>(new Set());
  const [dismissedChecks, setDismissedChecks] = useState<Set<string>>(new Set());

  // Load saved Chinese checks — auto-refreshes on page return
  const { data: savedChecks, loading, refetch } = useData<SeoCheck[]>(() =>
    api.get(`/api/projects/${projectId}/seo?language=zh`)
  );

  const { data: blogVersions } = useData<{ id: number; versionNumber: number; title: string; slug: string; blog?: string; metaDescription?: string; excerpt?: string }[]>(() =>
    api.get(`/api/projects/${projectId}/versions`)
  );

  const { data: project, loading: projectLoading } = useData<{ keyword?: string; name?: string }>(() =>
    api.get(`/api/projects/${projectId}`)
  );

  const latestZh = (blogVersions ?? []).find((v) => v.slug?.endsWith("-zh"));
  const hasZhBlog = !!latestZh;
  // Use the saved Chinese keyphrase from excerpt, or fall back to project keyword
  const resolvedKeyword = (latestZh?.excerpt || project?.keyword || "").trim();

  // Determine whether the saved audit is outdated
  const savedVersionId = liveAuditResult?.auditedVersionId || (savedChecks as any)?._versionId;
  const auditedVersion = (blogVersions ?? []).find((v: any) => v.id === savedVersionId);
  const isOutdated = latestZh && auditedVersion && latestZh.id !== auditedVersion.id;

  const handleRunAudit = useCallback(async () => {
    if (!hasZhBlog) {
      setAuditError("No Chinese translation found. Generate one on the Translation page first.");
      return;
    }
    setAuditing(true);
    setAuditError(null);
    setLiveAuditResult(null);
    try {
      const auditRunId = crypto.randomUUID();
      const result = await api.post<AuditResult>(`/api/projects/${projectId}/seo/audit`, {
        keyword: resolvedKeyword,
        metaDescription: latestZh?.metaDescription || "",
        blog: latestZh?.blog,
        language: "zh",
        versionNumber: latestZh?.versionNumber,
        _auditRunId: auditRunId,
      });
      setLiveAuditResult(result);
      setTimeout(() => refetch(), 500);
    } catch (err) {
      setAuditError(err instanceof Error ? err.message : "Audit failed");
    } finally {
      setAuditing(false);
    }
  }, [projectId, refetch, hasZhBlog, latestZh, resolvedKeyword]);

  if (projectLoading || (loading && !liveAuditResult)) return <ZhSeoSkeleton />;

  const auditChecks = liveAuditResult?.checks ?? (savedChecks ?? []) as SeoCheck[];
  const auditedVersionNumber = liveAuditResult?.auditedVersionNumber ?? (savedChecks as any)?._version;
  // Use server-provided overall score; fall back to simple average for saved checks only
  const overallScore = liveAuditResult?.overallScore ?? (auditChecks.length > 0
    ? Math.round(auditChecks.filter((c) => c.status !== "not_applicable").reduce((sum, c) => sum + (c.score ?? 0), 0) / Math.max(1, auditChecks.filter((c) => c.status !== "not_applicable").length))
    : 0);

  const statusIcon = (status: string) => {
    switch (status) {
      case "pass": return <CheckCircle2 size={16} className="text-accent-green" />;
      case "warning": return <AlertTriangle size={16} className="text-accent-warning" />;
      case "fail": return <XCircle size={16} className="text-accent-danger" />;
      default: return null;
    }
  };

  const scoreColor = overallScore >= 80 ? "text-accent-green" : overallScore >= 60 ? "text-accent-warning" : "text-accent-danger";
  const categories = [...new Set(auditChecks.map((c) => c.category))];

  return (
    <div className="max-w-[1200px] mx-auto px-10 py-8">
      <div className="flex items-center justify-between mb-10">
        <div>
          <h1 className="text-[38px] font-bold text-text-primary tracking-tight">Chinese SEO Audit</h1>
          <p className="text-[14px] text-text-secondary mt-1">
            {liveAuditResult
              ? `Audited v${liveAuditResult.auditedVersionNumber} (id: ${liveAuditResult.auditedVersionId})`
              : latestZh
                ? `Auditing v${latestZh.versionNumber} — ${latestZh.title}`
                : "Traditional Chinese content optimization report"}
            {isOutdated && (
              <span className="ml-2 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-accent-warning/10 text-accent-warning">
                outdated
              </span>
            )}
            {auditedVersionNumber && (
              <span className="ml-2 text-[12px] text-text-secondary/60">(last audited: v{auditedVersionNumber})</span>
            )}
          </p>
        </div>
        <Button
          icon={auditing ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
          onClick={handleRunAudit}
          disabled={auditing || !hasZhBlog}
        >
          {auditing ? "Running Audit..." : auditChecks.length > 0 ? "Re-run Audit" : "Run Audit"}
        </Button>
      </div>

      {auditError && (
        <div className="mb-6 p-4 bg-accent-danger/10 border border-accent-danger/30 rounded-[12px] flex items-start gap-3">
          <AlertTriangle size={18} className="text-accent-danger shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-[14px] font-medium text-accent-danger">Audit failed</p>
            <p className="text-[13px] text-text-secondary mt-0.5">{auditError}</p>
          </div>
        </div>
      )}

      {!hasZhBlog ? (
        <EmptyState
          icon={<Languages size={48} />}
          title="No Traditional Chinese version"
          description="Generate a Traditional Chinese translation on the Translation page first, then return here to run the Chinese SEO audit."
          actionLabel="Go to Translation"
          onAction={() => window.location.href = `/projects/${projectId}/translation`}
        />
      ) : auditChecks.length === 0 ? (
        <EmptyState
          icon={<Languages size={48} />}
          title="No Chinese SEO audit yet"
          description="Run an audit to analyze your Chinese content for SEO issues. We check character count, keyphrase, links, paragraphs, FAQ schema and more."
          actionLabel="Run Audit"
          onAction={handleRunAudit}
        />
      ) : (
        <>
          <div className="grid grid-cols-4 gap-4 mb-10">
            <Card className="col-span-1">
              <div className="flex flex-col items-center justify-center py-4">
                <div className={`text-[56px] font-bold tracking-tight ${scoreColor}`}>{overallScore}</div>
                <p className="text-[12px] text-text-secondary mt-1">out of 100</p>
                <p className="text-[14px] font-semibold text-text-primary mt-2">
                  {overallScore >= 80 ? "Great" : overallScore >= 60 ? "Good" : "Needs Work"}
                </p>
                {liveAuditResult && (
                  <div className="mt-3 flex gap-2">
                    <Badge variant="success">{liveAuditResult.summary.passed} Passed</Badge>
                    <Badge variant="warning">{liveAuditResult.summary.warnings} Warnings</Badge>
                    <Badge variant="danger">{liveAuditResult.summary.failed} Failed</Badge>
                    {liveAuditResult.summary.notApplicable > 0 && (
                      <Badge variant="neutral">{liveAuditResult.summary.notApplicable} N/A</Badge>
                    )}
                  </div>
                )}
              </div>
            </Card>

            <Card className="col-span-3">
                  <div className="grid grid-cols-2 gap-6">
                    <div>
                      <h3 className="text-[13px] font-medium text-text-secondary mb-3 uppercase tracking-wider">Score Breakdown</h3>
                      <div className="space-y-3">
                        {categories.map((cat) => {
                          const catChecks = auditChecks.filter((c) => c.category === cat).filter((c) => c.status !== "not_applicable");
                          const catScore = catChecks.length > 0
                            ? Math.round(catChecks.reduce((sum, c) => sum + (c.score ?? 0), 0) / catChecks.length)
                            : null;
                          if (catScore === null) return null;
                          return (
                            <div key={cat}>
                              <div className="flex items-center justify-between mb-1">
                                <span className="text-[13px] text-text-secondary">{cat}</span>
                                <span className="text-[13px] text-text-primary font-medium">{catScore}%</span>
                              </div>
                              <ProgressBar value={catScore} variant={catScore >= 80 ? "success" : catScore >= 60 ? "warning" : "primary"} size="sm" />
                            </div>
                          );
                        })}
                      </div>
                    </div>

                <div>
                  <h3 className="text-[13px] font-medium text-text-secondary mb-3 uppercase tracking-wider">Summary</h3>
                  <div className="space-y-2">
                    {[
                      { label: "Passed", count: auditChecks.filter((c) => c.status === "pass").length, color: "text-accent-green" },
                      { label: "Warnings", count: auditChecks.filter((c) => c.status === "warning").length, color: "text-accent-warning" },
                      { label: "Failed", count: auditChecks.filter((c) => c.status === "fail").length, color: "text-accent-danger" },
                      { label: "N/A", count: auditChecks.filter((c) => c.status === "not_applicable").length, color: "text-text-secondary/50" },
                    ].map((stat) => (
                      <div key={stat.label} className="flex items-center justify-between py-1">
                        <span className="text-[13px] text-text-secondary">{stat.label}</span>
                        <span className={`text-[16px] font-bold ${stat.color}`}>{stat.count}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </Card>
          </div>

          <div className="space-y-3">
            <h2 className="text-[18px] font-semibold text-text-primary mb-4">Detailed Checks</h2>
            {auditChecks.filter((check) => !dismissedChecks.has(check.id)).map((check) => {
              const isExpanded = expandedChecks.has(check.id);
              return (
                <Card key={check.id} padding="md" hover>
                  <div className="flex items-start gap-4">
                    <div className="mt-0.5">{statusIcon(check.status)}</div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-3 mb-1">
                        <h3 className="text-[15px] font-semibold text-text-primary">{check.label}</h3>
                        <Badge variant={check.status === "pass" ? "success" : check.status === "warning" ? "warning" : check.status === "not_applicable" ? "neutral" : "danger"}>
                          {check.status === "not_applicable" ? "N/A" : `${check.score}/100`}
                        </Badge>
                      </div>
                      <p className="text-[13px] text-text-secondary">
                        {check.measuredValue && check.targetValue
                          ? `${check.measuredValue} (target: ${check.targetValue})`
                          : check.measuredValue || check.explanation}
                      </p>
                      {check.explanation && check.measuredValue && check.targetValue && (
                        <p className="text-[12px] text-text-secondary/70 mt-1">{check.explanation}</p>
                      )}
                      {check.status !== "not_applicable" && isExpanded && (
                        <div className="mt-3 p-3 bg-bg-surface-secondary rounded-[10px] border border-border-subtle">
                          <div className="flex items-start gap-2">
                            <Sparkles size={14} className="text-accent-primary mt-0.5 shrink-0" />
                            <p className="text-[13px] text-text-primary">{check.explanation}</p>
                          </div>
                        </div>
                      )}
                    </div>
                    <Button
                      variant="ghost" size="sm"
                      icon={isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                      onClick={() => setExpandedChecks((prev) => { const n = new Set(prev); if (n.has(check.id)) n.delete(check.id); else n.add(check.id); return n; })}
                    />
                  </div>
                </Card>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
