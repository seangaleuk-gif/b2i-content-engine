"use client";

import { useState, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Plus,
  Search,
  ArrowRight,
  Clock,
  Globe,
  Loader2,
  Trash2,
  CheckSquare,
  Square,
} from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { NewProjectModal, type ProjectFormData } from "@/components/ui/NewProjectModal";
import { useData } from "@/lib/use-data";
import { api } from "@/lib/api-client";
import { relativeTime } from "@/lib/utils";

interface Project {
  id: number;
  name: string;
  status: string;
  keyword: string;
  audience: string;
  country: string;
  wordCount: number;
  updatedAt: string;
}

const statusBadgeVariant = (status: string) => {
  switch (status) {
    case "published":
      return "published" as const;
    case "draft":
      return "draft" as const;
    case "research":
      return "research" as const;
    case "images":
      return "images" as const;
    case "translation":
      return "translation" as const;
    default:
      return "neutral" as const;
  }
};

function ProjectsSkeleton() {
  return (
    <div className="max-w-[1400px] mx-auto px-10 py-8">
      <div className="flex items-center justify-between mb-10">
        <div>
          <Skeleton variant="text" width={200} height={38} />
          <Skeleton variant="text" width={120} className="mt-1" />
        </div>
        <Skeleton variant="rectangular" width={150} height={38} />
      </div>
      <Skeleton variant="rectangular" width={400} height={38} className="mb-6" />
      <Skeleton variant="rectangular" height={400} />
    </div>
  );
}

export default function ProjectsPage() {
  const [search, setSearch] = useState("");
  const [activeFilter, setActiveFilter] = useState("All");
  const [showNewProject, setShowNewProject] = useState(false);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<number | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const router = useRouter();
  const { data: projects, loading, refetch } = useData<Project[]>(() =>
    api.get("/api/projects")
  );

  const handleCreateProject = useCallback(async (formData: ProjectFormData) => {
    setCreating(true);
    const p = await api.post<Project>("/api/projects", formData);
    await refetch();
    router.push(`/projects/${p.id}`);
    setCreating(false);
  }, [refetch, router]);

  const handleDeleteProject = useCallback(async (projectId: number, projectName: string) => {
    if (!confirm(`Delete "${projectName}"? This cannot be undone.`)) return;
    setDeleting(projectId);
    await api.delete(`/api/projects/${projectId}`);
    await refetch();
    setDeleting(null);
  }, [refetch]);

  const toggleSelect = useCallback((id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const items = projects ?? [];
  const filtered = items.filter((p) => {
    const matchesSearch =
      !search ||
      p.name.toLowerCase().includes(search.toLowerCase()) ||
      p.keyword.toLowerCase().includes(search.toLowerCase());
    const matchesFilter =
      activeFilter === "All" || p.status === activeFilter.toLowerCase();
    return matchesSearch && matchesFilter;
  });

  const toggleSelectAll = useCallback(() => {
    if (selectedIds.size === filtered.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filtered.map((p) => p.id)));
    }
  }, [selectedIds.size, filtered]);

  const handleBulkDelete = useCallback(async () => {
    const count = selectedIds.size;
    if (!confirm(`Delete ${count} project${count !== 1 ? "s" : ""}? This cannot be undone.`)) return;
    setBulkDeleting(true);
    await Promise.all(Array.from(selectedIds).map((id) => api.delete(`/api/projects/${id}`)));
    setSelectedIds(new Set());
    await refetch();
    setBulkDeleting(false);
  }, [selectedIds, refetch]);

  if (loading) return <ProjectsSkeleton />;

  return (
    <div className="max-w-[1400px] mx-auto px-10 py-8">
      <div className="flex items-center justify-between mb-10">
        <div>
          <h1 className="text-[38px] font-bold text-text-primary tracking-tight">
            Projects
          </h1>
          <p className="text-[14px] text-text-secondary mt-1">
            {items.length} total projects
          </p>
        </div>
        <Button
          icon={<Plus size={16} />}
          onClick={() => setShowNewProject(true)}
        >
          New Project
        </Button>
      </div>

      <div className="flex items-center gap-3 mb-6">
        <div className="relative flex-1 max-w-md">
          <Search
            size={16}
            className="absolute left-3.5 top-1/2 -translate-y-1/2 text-text-secondary"
          />
          <input
            type="text"
            placeholder="Search projects..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-bg-surface border border-border-subtle rounded-[10px] pl-10 pr-4 py-2.5 text-[14px] text-text-primary placeholder:text-text-secondary/50 focus:outline-none focus:border-accent-primary/50 transition-all"
          />
        </div>
        {["All", "Draft", "Published", "Research", "Images"].map((filter) => (
          <Button
            key={filter}
            variant="ghost"
            size="sm"
            onClick={() => setActiveFilter(filter)}
            className={
              activeFilter === filter ? "bg-[rgba(255,255,255,0.06)]" : ""
            }
          >
            {filter}
          </Button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title={search ? "No matching projects" : "No projects yet"}
          description={
            search
              ? "Try adjusting your search or filter."
              : "Create your first project to get started with AI-powered content creation."
          }
          actionLabel="New Project"
        />
      ) : (
        <>
          {selectedIds.size > 0 && (
            <div className="flex items-center gap-3 mb-4 px-4 py-3 bg-accent-primary/10 border border-accent-primary/20 rounded-[10px]">
              <span className="text-[13px] font-medium text-accent-primary">
                {selectedIds.size} selected
              </span>
              <div className="flex-1" />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSelectedIds(new Set())}
              >
                Clear
              </Button>
              <Button
                variant="primary"
                size="sm"
                icon={bulkDeleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                onClick={handleBulkDelete}
                disabled={bulkDeleting}
              >
                {bulkDeleting ? "Deleting..." : `Delete ${selectedIds.size}`}
              </Button>
            </div>
          )}
          <div className="rounded-[12px] border border-border-subtle overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border-subtle bg-bg-surface">
                  <th className="px-5 py-3.5 w-10">
                    <button onClick={toggleSelectAll} className="text-text-secondary hover:text-text-primary transition-colors cursor-pointer">
                      {selectedIds.size === filtered.length && filtered.length > 0
                        ? <CheckSquare size={16} className="text-accent-primary" />
                        : <Square size={16} />
                      }
                    </button>
                  </th>
                  {["Project", "Status", "Keyword", "Country", "Words", "Updated", ""].map(
                    (header) => (
                      <th
                        key={header}
                        className="text-left px-5 py-3.5 text-[12px] font-medium text-text-secondary"
                      >
                        {header}
                      </th>
                    )
                  )}
                </tr>
              </thead>
              <tbody>
                {filtered.map((project) => (
                  <tr
                    key={project.id}
                    className="border-b border-border-subtle hover:bg-[rgba(255,255,255,0.02)] transition-colors cursor-pointer"
                  >
                    <td className="px-5 py-4" onClick={(e: React.MouseEvent) => e.stopPropagation()}>
                      <button onClick={() => toggleSelect(project.id)} className="text-text-secondary hover:text-text-primary transition-colors cursor-pointer">
                        {selectedIds.has(project.id)
                          ? <CheckSquare size={16} className="text-accent-primary" />
                          : <Square size={16} />
                        }
                      </button>
                    </td>
                    <td className="px-5 py-4">
                      <p className="text-[14px] font-medium text-text-primary">
                        {project.name}
                      </p>
                      <p className="text-[12px] text-text-secondary mt-0.5">
                        {project.audience || "--"}
                      </p>
                    </td>
                    <td className="px-5 py-4">
                      <Badge variant={statusBadgeVariant(project.status)}>
                        {project.status}
                      </Badge>
                    </td>
                    <td className="px-5 py-4">
                      <span className="text-[13px] text-text-secondary">
                        {project.keyword || "--"}
                      </span>
                    </td>
                    <td className="px-5 py-4">
                      <span className="text-[13px] text-text-secondary flex items-center gap-1.5">
                        <Globe size={12} />
                        {project.country || "US"}
                      </span>
                    </td>
                    <td className="px-5 py-4">
                      <span className="text-[13px] text-text-secondary">
                        {project.wordCount.toLocaleString()}
                      </span>
                    </td>
                    <td className="px-5 py-4">
                      <span className="text-[13px] text-text-secondary flex items-center gap-1.5">
                        <Clock size={12} />
                        {relativeTime(project.updatedAt)}
                      </span>
                    </td>
                    <td className="px-5 py-4">
                      <div className="flex items-center gap-1">
                        <Link href={`/projects/${project.id}`}>
                          <Button variant="ghost" size="sm" icon={<ArrowRight size={14} />}>
                            Open
                          </Button>
                        </Link>
                        <Button
                          variant="ghost"
                          size="sm"
                          icon={deleting === project.id ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                          onClick={(e: React.MouseEvent) => {
                            e.stopPropagation();
                            e.preventDefault();
                            handleDeleteProject(project.id, project.name);
                          }}
                          disabled={deleting === project.id}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <NewProjectModal
        open={showNewProject}
        onClose={() => setShowNewProject(false)}
        onSubmit={handleCreateProject}
      />
    </div>
  );
}
