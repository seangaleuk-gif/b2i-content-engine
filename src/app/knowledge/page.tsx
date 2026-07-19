"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  Search,
  Plus,
  Star,
  MoreHorizontal,
  Clock,
  Filter,
  Pin,
} from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { useData } from "@/lib/use-data";
import { api } from "@/lib/api-client";
import { relativeTime, formatDate } from "@/lib/utils";

interface KBItem {
  id: number;
  title: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  pinned: boolean;
}

function KnowledgeSkeleton() {
  return (
    <div className="flex h-full">
      <div className="flex-1 px-10 py-8">
        <div className="flex items-center justify-between mb-8">
          <div>
            <Skeleton variant="text" width={250} height={38} />
            <Skeleton variant="text" width={100} className="mt-1" />
          </div>
          <Skeleton variant="rectangular" width={160} height={38} />
        </div>
        <Skeleton variant="rectangular" width={400} height={38} className="mb-6" />
        <Skeleton variant="rectangular" height={400} />
      </div>
    </div>
  );
}

export default function KnowledgePage() {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<KBItem | null>(null);
  const [filterMode, setFilterMode] = useState<"all" | "pinned">("all");
  const [creating, setCreating] = useState(false);
  const router = useRouter();
  const { data: items, loading } = useData<KBItem[]>(() =>
    api.get("/api/knowledge")
  );

  const handleCreate = useCallback(async () => {
    setCreating(true);
    try {
      const doc = await api.post<KBItem>("/api/knowledge", {
        title: "Untitled Document",
        tags: [],
        pinned: false,
      });
      router.push(`/knowledge/${doc.id}`);
    } catch {
      setCreating(false);
    }
  }, [router]);

  if (loading) return <KnowledgeSkeleton />;

  const list = items ?? [];
  const filtered = (filterMode === "pinned" ? list.filter((i) => i.pinned) : list).filter((item) =>
    !search
      ? true
      : item.title.toLowerCase().includes(search.toLowerCase()) ||
        item.tags.some((tag) => tag.toLowerCase().includes(search.toLowerCase()))
  );

  return (
    <div className="flex h-full">
      <div className="flex-1 flex flex-col min-w-0">
        <div className="px-10 py-8">
          <div className="flex items-center justify-between mb-8">
            <div>
              <h1 className="text-[38px] font-bold text-text-primary tracking-tight">
                Knowledge Base
              </h1>
              <p className="text-[14px] text-text-secondary mt-1">
                {list.length} documents
              </p>
            </div>
            <Button icon={<Plus size={16} />} onClick={handleCreate} loading={creating}>
              {creating ? "Creating..." : "New Document"}
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
                placeholder="Search knowledge base..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full bg-bg-surface border border-border-subtle rounded-[10px] pl-10 pr-4 py-2.5 text-[14px] text-text-primary placeholder:text-text-secondary/50 focus:outline-none focus:border-accent-primary/50 transition-all"
              />
            </div>
            <Button
              variant="ghost"
              size="sm"
              icon={<Filter size={14} />}
              onClick={() => setFilterMode((prev) => (prev === "all" ? "pinned" : "all"))}
              className={filterMode !== "all" ? "bg-[rgba(255,255,255,0.06)]" : ""}
            >
              Filter
            </Button>
            <Button
              variant="ghost"
              size="sm"
              icon={<Pin size={14} />}
              onClick={() => setFilterMode((prev) => (prev === "pinned" ? "all" : "pinned"))}
              className={filterMode === "pinned" ? "bg-[rgba(255,255,255,0.06)]" : ""}
            >
              Pinned
            </Button>
          </div>

          {filtered.length === 0 ? (
            <EmptyState
              title={search ? "No matching documents" : "No documents yet"}
              description={
                search
                  ? "Try adjusting your search."
                  : "Add your first document to the knowledge base."
              }
              actionLabel="New Document"
              onAction={handleCreate}
            />
          ) : (
            <div className="rounded-[12px] border border-border-subtle overflow-hidden">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border-subtle bg-bg-surface">
                    {["", "Title", "Tags", "Created", "Updated", ""].map((h) => (
                      <th
                        key={h}
                        className="text-left px-5 py-3.5 text-[12px] font-medium text-text-secondary"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((item) => (
                    <tr
                      key={item.id}
                      className={`border-b border-border-subtle hover:bg-[rgba(255,255,255,0.02)] transition-colors cursor-pointer ${
                        selected?.id === item.id
                          ? "bg-accent-primary/5"
                          : ""
                      }`}
                      onClick={() => setSelected(item)}
                    >
                      <td className="px-5 py-4 w-10">
                        {item.pinned ? (
                          <Pin size={14} className="text-accent-warning" />
                        ) : (
                          <Star size={14} className="text-text-secondary/30" />
                        )}
                      </td>
                      <td className="px-5 py-4">
                        <p className="text-[14px] font-medium text-text-primary">
                          {item.title}
                        </p>
                      </td>
                      <td className="px-5 py-4">
                        <div className="flex items-center gap-1.5">
                          {item.tags.map((tag) => (
                            <Badge key={tag} variant="neutral">
                              {tag}
                            </Badge>
                          ))}
                        </div>
                      </td>
                      <td className="px-5 py-4">
                        <span className="text-[13px] text-text-secondary">
                          {formatDate(item.createdAt)}
                        </span>
                      </td>
                      <td className="px-5 py-4">
                        <span className="text-[13px] text-text-secondary">
                          {relativeTime(item.updatedAt)}
                        </span>
                      </td>
                      <td className="px-5 py-4">
                        <Button variant="ghost" size="sm" icon={<MoreHorizontal size={14} />} disabled title="Actions coming soon" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {selected && (
        <div className="w-[420px] shrink-0 border-l border-border-subtle bg-bg-surface overflow-y-auto">
          <div className="p-6">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-[20px] font-semibold text-text-primary">
                {selected.title}
              </h2>
              <Button variant="ghost" size="sm" icon={<MoreHorizontal size={14} />} disabled title="Actions coming soon" />
            </div>

            <div className="flex items-center gap-2 mb-6">
              {selected.tags.map((tag) => (
                <Badge key={tag} variant="neutral">
                  {tag}
                </Badge>
              ))}
              <Badge variant={selected.pinned ? "warning" : "neutral"}>
                {selected.pinned ? "Pinned" : "Unpinned"}
              </Badge>
            </div>

            <div className="flex items-center gap-4 mb-6 text-[12px] text-text-secondary">
              <span className="flex items-center gap-1.5">
                <Clock size={12} />
                Created {formatDate(selected.createdAt)}
              </span>
              <span className="flex items-center gap-1.5">
                <Clock size={12} />
                Updated {relativeTime(selected.updatedAt)}
              </span>
            </div>

            <div className="prose prose-invert prose-sm max-w-none">
              <div className="bg-bg-surface-secondary rounded-[12px] p-5 border border-border-subtle min-h-[300px]">
                <p className="text-[14px] text-text-secondary leading-relaxed">
                  Select a document to view and edit its content. This is a
                  rich-text editor area with full markdown support.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
