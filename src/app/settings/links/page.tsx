"use client";

import { useState, useCallback } from "react";
import {
  Plus,
  Edit3,
  Trash2,
  Check,
  X,
  Globe,
  Link,
  Zap,
  Activity,
  Lightbulb,
  Loader2,
} from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { Modal } from "@/components/ui/Modal";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { useData } from "@/lib/use-data";
import { api } from "@/lib/api-client";

interface InternalLink {
  id: number;
  displayText: string;
  url: string;
  keywords: string[];
  priority: number;
  minPerArticle: number;
  maxPerArticle: number;
  active: boolean;
  autoSynced: boolean;
  status: string;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

interface SuggestedLink {
  id: number;
  phrase: string;
  suggestedUrl: string;
  confidence: number;
  status: string;
  sourceContent?: string;
  projectId?: number;
  createdAt: string;
}

interface LinksData {
  links: InternalLink[];
  pendingSuggestions: number;
}

interface SuggestionsData {
  suggestions: SuggestedLink[];
}

const linkFormDefaults = {
  displayText: "",
  url: "",
  keywords: "",
  priority: 2,
  minPerArticle: 1,
  maxPerArticle: 3,
  active: true,
};

interface LinkFormInitial {
  id?: number;
  displayText?: string;
  url?: string;
  keywords?: string | string[];
  priority?: number;
  minPerArticle?: number;
  maxPerArticle?: number;
  active?: boolean;
}

function LinkForm({
  initial,
  onSave,
  onCancel,
  saving,
}: {
  initial?: LinkFormInitial;
  onSave: (data: typeof linkFormDefaults & { id?: number }) => void;
  onCancel: () => void;
  saving: boolean;
}) {
  const [form, setForm] = useState({
    displayText: initial?.displayText ?? linkFormDefaults.displayText,
    url: initial?.url ?? linkFormDefaults.url,
    keywords: Array.isArray(initial?.keywords) ? initial.keywords.join(", ") : (initial?.keywords ?? ""),
    priority: initial?.priority ?? linkFormDefaults.priority,
    minPerArticle: initial?.minPerArticle ?? linkFormDefaults.minPerArticle,
    maxPerArticle: initial?.maxPerArticle ?? linkFormDefaults.maxPerArticle,
    active: initial?.active ?? linkFormDefaults.active,
  });

  return (
    <div className="space-y-4">
      <Input
        label="Display Text"
        value={form.displayText}
        onChange={(e) => setForm({ ...form, displayText: e.target.value })}
        placeholder="e.g. B2I Digital Marketing"
      />
      <Input
        label="URL Slug"
        value={form.url}
        onChange={(e) => setForm({ ...form, url: e.target.value })}
        placeholder="/blog/slug-name"
      />
      <Input
        label="Keywords (comma-separated)"
        value={form.keywords}
        onChange={(e) => setForm({ ...form, keywords: e.target.value })}
        placeholder="digital marketing, content strategy"
      />
      <div className="grid grid-cols-3 gap-4">
        <div className="flex flex-col gap-1.5">
          <label className="text-[13px] font-medium text-text-secondary">
            Priority (1-5)
          </label>
          <select
            value={form.priority}
            onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })}
            className="bg-bg-surface border border-border-subtle rounded-[10px] px-3.5 py-2.5 text-[14px] text-text-primary focus:outline-none focus:border-accent-primary/50 transition-all"
          >
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
        <Input
          label="Min Per Article"
          type="number"
          value={form.minPerArticle}
          onChange={(e) => setForm({ ...form, minPerArticle: Math.max(0, Number(e.target.value)) })}
        />
        <Input
          label="Max Per Article"
          type="number"
          value={form.maxPerArticle}
          onChange={(e) => setForm({ ...form, maxPerArticle: Math.max(1, Number(e.target.value)) })}
        />
      </div>
      <label className="flex items-center gap-3 text-[14px] text-text-primary cursor-pointer">
        <input
          type="checkbox"
          checked={form.active}
          onChange={(e) => setForm({ ...form, active: e.target.checked })}
          className="w-4 h-4 rounded border-border-subtle bg-bg-surface accent-accent-primary"
        />
        Active
      </label>
      <div className="flex items-center gap-2 pt-2">
        <Button onClick={() => onSave({ ...form, id: initial?.id })} loading={saving}>
          {initial?.id ? "Save Changes" : "Add Link"}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function StatsRow({ links, pendingCount }: { links: InternalLink[]; pendingCount: number }) {
  const active = links.filter((l) => l.active).length;
  const autoSynced = links.filter((l) => l.autoSynced).length;

  return (
    <div className="grid grid-cols-4 gap-4">
      <Card>
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-[#4F7DF7]/10">
            <Link size={18} className="text-[#4F7DF7]" />
          </div>
          <div>
            <p className="text-[12px] text-text-secondary">Total Links</p>
            <p className="text-[20px] font-bold text-text-primary">{links.length}</p>
          </div>
        </div>
      </Card>
      <Card>
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-[#22C55E]/10">
            <Zap size={18} className="text-[#22C55E]" />
          </div>
          <div>
            <p className="text-[12px] text-text-secondary">Active</p>
            <p className="text-[20px] font-bold text-text-primary">{active}</p>
          </div>
        </div>
      </Card>
      <Card>
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-[#A855F7]/10">
            <Activity size={18} className="text-[#A855F7]" />
          </div>
          <div>
            <p className="text-[12px] text-text-secondary">Auto-Synced</p>
            <p className="text-[20px] font-bold text-text-primary">{autoSynced}</p>
          </div>
        </div>
      </Card>
      <Card>
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-[#F59E0B]/10">
            <Lightbulb size={18} className="text-[#F59E0B]" />
          </div>
          <div>
            <p className="text-[12px] text-text-secondary">Suggestions</p>
            <p className="text-[20px] font-bold text-text-primary">{pendingCount}</p>
          </div>
        </div>
      </Card>
    </div>
  );
}

function ConfirmModal({
  open,
  onClose,
  onConfirm,
  title,
  message,
  loading,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  loading: boolean;
}) {
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <p className="text-[14px] text-text-secondary mb-5">{message}</p>
      <div className="flex items-center gap-2">
        <Button variant="danger" onClick={onConfirm} loading={loading}>
          Confirm
        </Button>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </Modal>
  );
}

export default function LinksSettingsPage() {
  const [modalOpen, setModalOpen] = useState(false);
  const [editingLink, setEditingLink] = useState<InternalLink | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<InternalLink | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [processingSuggestion, setProcessingSuggestion] = useState<number | null>(null);

  const {
    data: linksData,
    loading: linksLoading,
    error: linksError,
    refetch: refetchLinks,
  } = useData<LinksData>(() => api.get("/api/internal-links"));

  const {
    data: suggestionsData,
    loading: suggestionsLoading,
    refetch: refetchSuggestions,
  } = useData<SuggestionsData>(() => api.get("/api/suggested-links"));

  const links = linksData?.links ?? [];
  const pendingCount = linksData?.pendingSuggestions ?? 0;
  const suggestions = suggestionsData?.suggestions ?? [];

  const handleAdd = () => {
    setEditingLink(null);
    setModalOpen(true);
  };

  const handleEdit = (link: InternalLink) => {
    setEditingLink(link);
    setModalOpen(true);
  };

  const handleSave = async (data: typeof linkFormDefaults & { id?: number }) => {
    setSaving(true);
    try {
      const keywordsArr = data.keywords
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean);

      const payload = {
        displayText: data.displayText,
        url: data.url,
        keywords: keywordsArr,
        priority: data.priority,
        minPerArticle: data.minPerArticle,
        maxPerArticle: data.maxPerArticle,
        active: data.active,
      };

      if (data.id) {
        await api.patch(`/api/internal-links/${data.id}`, payload);
      } else {
        await api.post("/api/internal-links", payload);
      }

      setModalOpen(false);
      setEditingLink(null);
      refetchLinks();
    } catch (err) {
      console.error("Failed to save link:", err);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.delete(`/api/internal-links/${deleteTarget.id}`);
      setDeleteTarget(null);
      refetchLinks();
    } catch (err) {
      console.error("Failed to delete link:", err);
    } finally {
      setDeleting(false);
    }
  };

  const handleToggleActive = async (link: InternalLink) => {
    try {
      await api.patch(`/api/internal-links/${link.id}`, { active: !link.active });
      refetchLinks();
    } catch (err) {
      console.error("Failed to toggle link:", err);
    }
  };

  const handleSuggestionAction = async (id: number, action: "approve" | "reject") => {
    setProcessingSuggestion(id);
    try {
      await api.post("/api/suggested-links", { id, action });
      refetchSuggestions();
      refetchLinks();
    } catch (err) {
      console.error("Failed to process suggestion:", err);
    } finally {
      setProcessingSuggestion(null);
    }
  };

  return (
    <div className="max-w-[1200px] mx-auto px-10 py-8">
      <div className="flex items-center justify-between mb-2">
        <h1 className="text-[38px] font-bold text-text-primary tracking-tight">
          Internal Links
        </h1>
        <Button onClick={handleAdd} icon={<Plus size={16} />}>
          Add Link
        </Button>
      </div>
      <p className="text-[14px] text-text-secondary mb-8">
        Manage internal linking strategy for automated link injection in blog posts
      </p>

      {linksLoading ? (
        <div className="grid grid-cols-4 gap-4 mb-8">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} variant="rectangular" height={80} />
          ))}
        </div>
      ) : (
        <div className="mb-8">
          <StatsRow links={links} pendingCount={pendingCount} />
        </div>
      )}

      {linksError && (
        <div className="mb-8 p-4 bg-accent-danger/10 border border-accent-danger/20 rounded-[12px] text-[14px] text-accent-danger">
          {linksError}
        </div>
      )}

      <Card padding="none" className="mb-8">
        {linksLoading ? (
          <div className="p-5 space-y-3">
            {[1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} variant="rectangular" height={48} />
            ))}
          </div>
        ) : links.length === 0 ? (
          <EmptyState
            icon={<Link size={48} />}
            title="No internal links yet"
            description="Add your first internal link to enable automated link injection in your blog content."
            actionLabel="Add Link"
            onAction={handleAdd}
          />
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-border-subtle">
                <th className="text-left px-5 py-3 text-[12px] font-medium text-text-secondary uppercase tracking-wide">
                  Display Text
                </th>
                <th className="text-left px-5 py-3 text-[12px] font-medium text-text-secondary uppercase tracking-wide">
                  URL
                </th>
                <th className="text-left px-5 py-3 text-[12px] font-medium text-text-secondary uppercase tracking-wide">
                  Keywords
                </th>
                <th className="text-center px-5 py-3 text-[12px] font-medium text-text-secondary uppercase tracking-wide">
                  Priority
                </th>
                <th className="text-center px-5 py-3 text-[12px] font-medium text-text-secondary uppercase tracking-wide">
                  Min/Max
                </th>
                <th className="text-center px-5 py-3 text-[12px] font-medium text-text-secondary uppercase tracking-wide">
                  Active
                </th>
                <th className="text-center px-5 py-3 text-[12px] font-medium text-text-secondary uppercase tracking-wide">
                  Status
                </th>
                <th className="text-right px-5 py-3 text-[12px] font-medium text-text-secondary uppercase tracking-wide">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {links.map((link) => (
                <tr
                  key={link.id}
                  className="border-b border-border-subtle last:border-0 hover:bg-[rgba(255,255,255,0.02)] transition-colors"
                >
                  <td className="px-5 py-3 text-[14px] text-text-primary font-medium">
                    {link.displayText}
                  </td>
                  <td className="px-5 py-3">
                    <span className="inline-flex items-center gap-1.5 text-[13px] text-[#4F7DF7] font-mono">
                      <Globe size={12} />
                      {link.url}
                    </span>
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex flex-wrap gap-1">
                      {(link.keywords ?? []).slice(0, 3).map((kw, i) => (
                        <Badge key={i} variant="neutral">
                          {kw}
                        </Badge>
                      ))}
                      {(link.keywords ?? []).length > 3 && (
                        <Badge variant="neutral">
                          +{(link.keywords ?? []).length - 3}
                        </Badge>
                      )}
                    </div>
                  </td>
                  <td className="px-5 py-3 text-center">
                    <span className="text-[14px] text-text-primary font-medium">
                      {link.priority}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-center">
                    <span className="text-[13px] text-text-secondary">
                      {link.minPerArticle}/{link.maxPerArticle}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-center">
                    <button
                      onClick={() => handleToggleActive(link)}
                      className={`inline-flex items-center justify-center w-9 h-5 rounded-full transition-colors cursor-pointer ${
                        link.active ? "bg-[#22C55E]" : "bg-[#334155]"
                      }`}
                    >
                      <span
                        className={`w-3.5 h-3.5 rounded-full bg-white shadow-sm transition-transform ${
                          link.active ? "translate-x-2" : "-translate-x-2"
                        }`}
                      />
                    </button>
                  </td>
                  <td className="px-5 py-3 text-center">
                    {link.autoSynced ? (
                      <Badge variant="research">Auto</Badge>
                    ) : (
                      <Badge
                        variant={link.active ? "success" : "neutral"}
                      >
                        {link.active ? "Active" : "Inactive"}
                      </Badge>
                    )}
                  </td>
                  <td className="px-5 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleEdit(link)}
                        icon={<Edit3 size={14} />}
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setDeleteTarget(link)}
                        icon={<Trash2 size={14} />}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {suggestions.length > 0 && (
        <Card padding="none">
          <div className="px-5 py-4 border-b border-border-subtle">
            <h2 className="text-[18px] font-semibold text-text-primary flex items-center gap-2">
              <Lightbulb size={18} className="text-[#F59E0B]" />
              Suggestions Pending
            </h2>
          </div>
          {suggestionsLoading ? (
            <div className="p-5 space-y-3">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} variant="rectangular" height={48} />
              ))}
            </div>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="border-b border-border-subtle">
                  <th className="text-left px-5 py-3 text-[12px] font-medium text-text-secondary uppercase tracking-wide">
                    Phrase
                  </th>
                  <th className="text-left px-5 py-3 text-[12px] font-medium text-text-secondary uppercase tracking-wide">
                    Suggested URL
                  </th>
                  <th className="text-center px-5 py-3 text-[12px] font-medium text-text-secondary uppercase tracking-wide">
                    Confidence
                  </th>
                  <th className="text-left px-5 py-3 text-[12px] font-medium text-text-secondary uppercase tracking-wide">
                    Source
                  </th>
                  <th className="text-right px-5 py-3 text-[12px] font-medium text-text-secondary uppercase tracking-wide">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {suggestions.map((s) => (
                  <tr
                    key={s.id}
                    className="border-b border-border-subtle last:border-0 hover:bg-[rgba(255,255,255,0.02)] transition-colors"
                  >
                    <td className="px-5 py-3 text-[14px] text-text-primary font-medium">
                      {s.phrase}
                    </td>
                    <td className="px-5 py-3">
                      <span className="text-[13px] text-[#4F7DF7] font-mono">
                        {s.suggestedUrl}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-center">
                      <div className="flex items-center justify-center gap-2">
                        <div className="w-16 h-1.5 rounded-full bg-bg-surface-secondary overflow-hidden">
                          <div
                            className="h-full rounded-full bg-[#F59E0B] transition-all"
                            style={{ width: `${(s.confidence * 100)}%` }}
                          />
                        </div>
                        <span className="text-[13px] text-text-secondary">
                          {Math.round(s.confidence * 100)}%
                        </span>
                      </div>
                    </td>
                    <td className="px-5 py-3">
                      <span className="text-[13px] text-text-secondary truncate max-w-[200px] block">
                        {s.sourceContent ?? "—"}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={() => handleSuggestionAction(s.id, "approve")}
                          loading={processingSuggestion === s.id}
                          icon={<Check size={14} />}
                        >
                          Approve
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleSuggestionAction(s.id, "reject")}
                          disabled={processingSuggestion === s.id}
                          icon={<X size={14} />}
                        >
                          Reject
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}

      <Modal
        open={modalOpen}
        onClose={() => {
          setModalOpen(false);
          setEditingLink(null);
        }}
        title={editingLink ? "Edit Link" : "Add Link"}
        maxWidth="max-w-xl"
      >
        <LinkForm
          initial={
            editingLink
              ? {
                  id: editingLink.id,
                  displayText: editingLink.displayText,
                  url: editingLink.url,
                  keywords: (editingLink.keywords ?? []).join(", "),
                  priority: editingLink.priority,
                  minPerArticle: editingLink.minPerArticle,
                  maxPerArticle: editingLink.maxPerArticle,
                  active: editingLink.active,
                }
              : undefined
          }
          onSave={handleSave}
          onCancel={() => {
            setModalOpen(false);
            setEditingLink(null);
          }}
          saving={saving}
        />
      </Modal>

      <ConfirmModal
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title="Delete Link"
        message={`Are you sure you want to delete "${deleteTarget?.displayText}"? This action cannot be undone.`}
        loading={deleting}
      />
    </div>
  );
}
