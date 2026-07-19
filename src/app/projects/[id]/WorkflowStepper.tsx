"use client";

import { useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  CheckCircle2,
  Circle,
  ChevronRight,
  Search,
  BarChart3,
  BookOpen,
  PenLine,
  Gauge,
  Image,
  Share2,
  Languages,
  Send,
  Sparkles,
} from "lucide-react";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { useData } from "@/lib/use-data";
import { api } from "@/lib/api-client";

type StepStatus = "complete" | "in-progress" | "pending";

interface WorkflowStep {
  id: string;
  label: string;
  icon: React.ReactNode;
  status: StepStatus;
}

const stepDefs = [
  { id: "research", label: "Research", icon: <Search size={16} />, path: "research" },
  { id: "editor", label: "Blog Generation", icon: <Sparkles size={16} />, path: "" },
  { id: "competitor", label: "Competitor Analysis", icon: <BarChart3 size={16} />, path: "competitor" },
  { id: "outline", label: "Outline", icon: <BookOpen size={16} />, path: "outline" },
  { id: "blog", label: "Blog", icon: <PenLine size={16} />, path: "blog" },
  { id: "seo", label: "SEO Audit", icon: <Gauge size={16} />, path: "seo" },
  { id: "images", label: "Images", icon: <Image size={16} />, path: "images" },
  { id: "social", label: "Social", icon: <Share2 size={16} />, path: "social" },
  { id: "translation", label: "Translation", icon: <Languages size={16} />, path: "translation" },
  { id: "publish", label: "Publish", icon: <Send size={16} />, path: "publish" },
];

export function WorkflowStepper() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;

  const { data: project } = useData<any>(() => api.get(`/api/projects/${projectId}`));
  const { data: researchItems } = useData<any[]>(() => api.get(`/api/projects/${projectId}/research`));
  const { data: versions } = useData<any[]>(() => api.get(`/api/projects/${projectId}/versions`));
  const { data: seoItems } = useData<any[]>(() => api.get(`/api/projects/${projectId}/seo`));
  const { data: imageItems } = useData<any[]>(() => api.get(`/api/projects/${projectId}/images`));
  const { data: socialItems } = useData<any[]>(() => api.get(`/api/projects/${projectId}/social`));

  const steps: WorkflowStep[] = useMemo(() => {
    const researchDone = (researchItems?.length ?? 0) > 0;
    const blogDone = (versions?.length ?? 0) > 0 || (project?.content?.length ?? 0) > 100;
    const outlineDone = blogDone || (project?.wordCount ?? 0) > 0;
    const seoDone = (seoItems?.length ?? 0) > 0;
    const imagesDone = (imageItems?.length ?? 0) > 0;
    const socialDone = (socialItems?.length ?? 0) > 0;

    const statuses: Record<string, StepStatus> = {
      research: researchDone ? "complete" : "in-progress",
      editor: blogDone ? "complete" : researchDone ? "in-progress" : "pending",
      competitor: researchDone ? "complete" : "pending",
      outline: outlineDone ? "complete" : researchDone ? "in-progress" : "pending",
      blog: blogDone ? "complete" : outlineDone ? "in-progress" : "pending",
      seo: seoDone ? "complete" : blogDone ? "in-progress" : "pending",
      images: imagesDone ? "complete" : blogDone ? "in-progress" : "pending",
      social: socialDone ? "complete" : blogDone ? "in-progress" : "pending",
      translation: "pending",
      publish: project?.status === "published" ? "complete" : blogDone ? "in-progress" : "pending",
    };

    return stepDefs.map((def) => ({ ...def, status: statuses[def.id] || "pending" }));
  }, [researchItems, seoItems, imageItems, socialItems, versions, project]);

  const completedCount = steps.filter((s) => s.status === "complete").length;
  const progressPercent = Math.round((completedCount / steps.length) * 100);

  return (
    <div className="w-[240px] shrink-0 border-r border-border-subtle bg-bg-surface flex flex-col">
      <div className="p-5 border-b border-border-subtle">
        <h2 className="text-[14px] font-semibold text-text-primary">Workflow</h2>
        <ProgressBar value={progressPercent} className="mt-3" />
        <p className="text-[12px] text-text-secondary mt-1.5">{completedCount} of {steps.length} complete</p>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-0.5">
        {steps.map((step) => (
          <button
            key={step.id}
            onClick={() => {
              let route = (step as any).path
                ? `/projects/${projectId}/${(step as any).path}`
                : `/projects/${projectId}`;
              const versionParam = new URLSearchParams(window.location.search).get("version");
              if (versionParam) {
                route += `?version=${versionParam}`;
              }
              router.push(route);
            }}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-[10px] text-left transition-all duration-150 cursor-pointer ${
              step.status === "in-progress"
                ? "bg-accent-primary/10 text-accent-primary"
                : step.status === "complete"
                ? "text-text-secondary hover:bg-[rgba(255,255,255,0.04)]"
                : "text-text-secondary/50 hover:bg-[rgba(255,255,255,0.04)]"
            }`}
          >
            {step.status === "complete" ? (
              <CheckCircle2 size={16} className="text-accent-green shrink-0" />
            ) : step.status === "in-progress" ? (
              <Circle size={16} className="text-accent-primary shrink-0 fill-accent-primary/20" />
            ) : (
              <Circle size={16} className="text-text-secondary/30 shrink-0" />
            )}
            <span className="text-[13px] font-medium">{step.label}</span>
            {step.status === "in-progress" && (
              <ChevronRight size={14} className="ml-auto" />
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
