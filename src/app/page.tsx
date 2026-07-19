"use client";

import {
  Plus,
  ArrowRight,
  Clock,
  FileText,
  Globe,
  Search,
  Edit3,
} from "lucide-react";
import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { useData } from "@/lib/use-data";
import { api } from "@/lib/api-client";
import { relativeTime } from "@/lib/utils";
import { NewProjectModal, type ProjectFormData } from "@/components/ui/NewProjectModal";
import { useRouter } from "next/navigation";
import { useState, useCallback } from "react";

interface Project {
  id: number;
  name: string;
  status: string;
  keyword: string;
  updatedAt: string;
}

interface ActivityItem {
  id: number;
  action: string;
  description: string;
  type: string;
  createdAt: string;
}

interface DashboardData {
  stats: {
    totalProjects: number;
    published: number;
    drafts: number;
    research: number;
  };
  recentProjects: Project[];
  activity: ActivityItem[];
  profile: {
    apiCreditsUsed: number;
    apiCreditsLimit: number;
    storageUsedBytes: number;
    storageLimitBytes: number;
  };
}

const statusBadgeVariant = (status: string) => {
  switch (status) {
    case "published":
      return "published" as const;
    case "draft":
      return "draft" as const;
    case "research":
      return "research" as const;
    default:
      return "neutral" as const;
  }
};

const activityIcon = (type: string) => {
  switch (type) {
    case "publish":
      return <Globe size={14} className="text-accent-green" />;
    case "audit":
      return <Search size={14} className="text-accent-primary" />;
    case "research":
      return <FileText size={14} className="text-accent-warning" />;
    case "draft":
      return <Edit3 size={14} className="text-text-secondary" />;
    case "social":
      return <ArrowRight size={14} className="text-accent-primary" />;
    default:
      return <ArrowRight size={14} className="text-text-secondary" />;
  }
};

function DashboardSkeleton() {
  return (
    <div className="max-w-[1400px] mx-auto px-10 py-8">
      <div className="flex items-start justify-between mb-10">
        <div>
          <Skeleton variant="text" width={200} className="mb-2" />
          <Skeleton variant="text" width={350} height={38} />
        </div>
        <div className="flex items-center gap-3">
          <Skeleton variant="rectangular" width={180} height={38} />
          <Skeleton variant="rectangular" width={150} height={38} />
        </div>
      </div>
      <div className="grid grid-cols-4 gap-4 mb-10">
        {[1, 2, 3, 4].map((i) => (
          <Card key={i} padding="lg">
            <Skeleton variant="text" width={80} className="mb-2" />
            <Skeleton variant="text" width={60} height={32} className="mb-1" />
            <Skeleton variant="text" width={100} />
          </Card>
        ))}
      </div>
      <div className="flex gap-8">
        <div className="flex-1">
          <Skeleton variant="text" width={150} className="mb-4" />
          <Skeleton variant="rectangular" height={300} />
        </div>
        <div className="w-[320px] space-y-5">
          <Skeleton variant="rectangular" height={250} />
          <Skeleton variant="rectangular" height={200} />
          <Skeleton variant="rectangular" height={150} />
        </div>
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const [showNewProject, setShowNewProject] = useState(false);
  const router = useRouter();
  const { data, loading, error } = useData<DashboardData>(() =>
    api.get("/api/dashboard")
  );

  const handleCreateProject = useCallback(async (formData: ProjectFormData) => {
    const p = await api.post<{ id: number }>("/api/projects", formData);
    router.push(`/projects/${p.id}`);
  }, [router]);

  if (loading) return <DashboardSkeleton />;

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-text-secondary">Failed to load dashboard. Please try again.</p>
      </div>
    );
  }

  if (!data) return null;

  const { stats, recentProjects, activity, profile } = data;
  const apiPct = Math.round((profile.apiCreditsUsed / profile.apiCreditsLimit) * 100);
  const storagePct = Math.round((profile.storageUsedBytes / profile.storageLimitBytes) * 100);

  return (
    <div className="max-w-[1400px] mx-auto px-10 py-8">
      <div className="flex items-start justify-between mb-10">
        <div>
          <p className="text-[13px] text-text-secondary mb-1 font-medium">
            Good morning, Sean
          </p>
          <h1 className="text-[38px] font-bold text-text-primary tracking-tight leading-tight">
            What should you work on next?
          </h1>
        </div>
        <div className="flex items-center gap-3">
          {recentProjects.length > 0 ? (
            <Link href={`/projects/${recentProjects[0].id}`}>
              <Button variant="secondary" icon={<ArrowRight size={16} />}>
                Continue Last Project
              </Button>
            </Link>
          ) : (
            <Link href="/projects">
              <Button variant="secondary" icon={<ArrowRight size={16} />}>
                Go to Projects
              </Button>
            </Link>
          )}
          <Link href="/projects">
            <Button icon={<Plus size={16} />} onClick={(e) => { e.preventDefault(); setShowNewProject(true); }}>
              New Project
            </Button>
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-4 mb-10">
        {[
          { label: "Projects", value: stats.totalProjects, sub: `${stats.drafts + stats.research} active` },
          { label: "Published", value: stats.published, sub: "This month" },
          { label: "Drafts", value: stats.drafts, sub: "In progress" },
          { label: "Research", value: stats.research, sub: "Waiting" },
        ].map((stat) => (
          <Card key={stat.label} padding="lg">
            <p className="text-[13px] text-text-secondary font-medium mb-1">
              {stat.label}
            </p>
            <p className="text-[32px] font-bold text-text-primary tracking-tight">
              {stat.value}
            </p>
            <p className="text-[12px] text-text-secondary mt-1">{stat.sub}</p>
          </Card>
        ))}
      </div>

      <div className="flex gap-8">
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-[18px] font-semibold text-text-primary">
              Recent Projects
            </h2>
            <Link href="/projects">
              <Button variant="ghost" size="sm">
                View All
              </Button>
            </Link>
          </div>

          {recentProjects.length === 0 ? (
            <Card className="flex flex-col items-center justify-center py-16 text-center">
              <FileText size={40} className="text-text-secondary/30 mb-3" />
              <p className="text-[14px] text-text-secondary mb-4">
                No projects yet. Create your first project to get started.
              </p>
              <Link href="/projects">
                <Button icon={<Plus size={16} />} onClick={(e) => { e.preventDefault(); setShowNewProject(true); }}>Create Project</Button>
              </Link>
            </Card>
          ) : (
            <div className="rounded-[12px] border border-border-subtle overflow-hidden">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border-subtle">
                    {["Project", "Status", "Keyword", "Updated", ""].map(
                      (header) => (
                        <th
                          key={header}
                          className="text-left px-5 py-3 text-[12px] font-medium text-text-secondary"
                        >
                          {header}
                        </th>
                      )
                    )}
                  </tr>
                </thead>
                <tbody>
                  {recentProjects.map((project) => (
                    <tr
                      key={project.id}
                      className="border-b border-border-subtle hover:bg-[rgba(255,255,255,0.02)] transition-colors"
                    >
                      <td className="px-5 py-3.5">
                        <p className="text-[14px] font-medium text-text-primary">
                          {project.name}
                        </p>
                      </td>
                      <td className="px-5 py-3.5">
                        <Badge variant={statusBadgeVariant(project.status)}>
                          {project.status}
                        </Badge>
                      </td>
                      <td className="px-5 py-3.5">
                        <span className="text-[13px] text-text-secondary">
                          {project.keyword}
                        </span>
                      </td>
                      <td className="px-5 py-3.5">
                        <span className="text-[13px] text-text-secondary flex items-center gap-1.5">
                          <Clock size={12} />
                          {relativeTime(project.updatedAt)}
                        </span>
                      </td>
                      <td className="px-5 py-3.5">
                        <Link href={`/projects/${project.id}`}>
                          <Button variant="ghost" size="sm">
                            Open
                          </Button>
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="w-[320px] shrink-0 space-y-5">
          <Card>
            <h3 className="text-[16px] font-semibold text-text-primary mb-4">
              Activity
            </h3>
            <div className="space-y-0">
              {activity.length === 0 ? (
                <p className="text-[13px] text-text-secondary py-4 text-center">
                  No recent activity
                </p>
              ) : (
                activity.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-start gap-3 py-2.5 border-b border-border-subtle last:border-0"
                  >
                    <div className="mt-0.5">{activityIcon(item.type)}</div>
                    <div className="min-w-0">
                      <p className="text-[13px] text-text-primary truncate">
                        <span className="font-medium">{item.action}</span>{" "}
                        {item.description}
                      </p>
                      <p className="text-[11px] text-text-secondary mt-0.5">
                        {relativeTime(item.createdAt)}
                      </p>
                    </div>
                  </div>
                ))
              )}
            </div>
          </Card>

          <Card>
            <h3 className="text-[16px] font-semibold text-text-primary mb-4">
              Latest Publishes
            </h3>
            <div className="space-y-3">
              {recentProjects
                .filter((p) => p.status === "published")
                .slice(0, 3)
                .map((pub) => (
                  <div key={pub.id} className="flex items-center justify-between">
                    <div className="min-w-0">
                      <p className="text-[13px] text-text-primary truncate font-medium">
                        {pub.name}
                      </p>
                      <p className="text-[11px] text-text-secondary truncate">
                        {pub.keyword}
                      </p>
                    </div>
                    <span className="text-[11px] text-text-secondary shrink-0 ml-3">
                      {relativeTime(pub.updatedAt)}
                    </span>
                  </div>
                ))}
              {recentProjects.filter((p) => p.status === "published").length === 0 && (
                <p className="text-[13px] text-text-secondary py-2 text-center">
                  No published projects yet
                </p>
              )}
            </div>
          </Card>

          <Card>
            <h3 className="text-[16px] font-semibold text-text-primary mb-4">
              Resources
            </h3>
            <div className="space-y-3">
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[13px] text-text-secondary">
                    API Credits
                  </span>
                  <span className="text-[13px] text-text-primary font-medium">
                    {profile.apiCreditsUsed.toLocaleString()} / {profile.apiCreditsLimit.toLocaleString()}
                  </span>
                </div>
                <div className="h-1.5 bg-bg-surface-secondary rounded-full overflow-hidden">
                  <div
                    className="h-full bg-accent-primary rounded-full"
                    style={{ width: `${apiPct}%` }}
                  />
                </div>
              </div>
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[13px] text-text-secondary">
                    Storage
                  </span>
                  <span className="text-[13px] text-text-primary font-medium">
                    {(profile.storageUsedBytes / 1073741824).toFixed(1)} GB / {(profile.storageLimitBytes / 1073741824).toFixed(0)} GB
                  </span>
                </div>
                <div className="h-1.5 bg-bg-surface-secondary rounded-full overflow-hidden">
                  <div
                    className="h-full bg-accent-green rounded-full"
                    style={{ width: `${storagePct}%` }}
                  />
                </div>
              </div>
            </div>
          </Card>
        </div>
      </div>

      <NewProjectModal
        open={showNewProject}
        onClose={() => setShowNewProject(false)}
        onSubmit={handleCreateProject}
      />
    </div>
  );
}
