"use client";

import { useState, useCallback } from "react";
import { useParams } from "next/navigation";
import {
  Image as ImageIcon,
  Copy,
  Sparkles,
  RefreshCw,
  Edit3,
  Download,
  Monitor,
  Square,
  PanelTop,
  Loader2,
  CheckCircle2,
  Trash2,
} from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { useData } from "@/lib/use-data";
import { api } from "@/lib/api-client";

interface ImageItem {
  id: number;
  type: string;
  width: number;
  height: number;
  prompt: string;
  url: string | null;
  status: string;
}

const imageConfigs: Record<string, { title: string; icon: React.ReactNode }> = {
  featured: { title: "Featured Image", icon: <Monitor size={20} /> },
  social: { title: "Social Image", icon: <Square size={20} /> },
  facebook: { title: "Facebook Image", icon: <PanelTop size={20} /> },
};

function ImagesSkeleton() {
  return (
    <div className="max-w-[1400px] mx-auto px-10 py-8">
      <div className="flex items-center justify-between mb-10">
        <div><Skeleton variant="text" width={250} height={38} /><Skeleton variant="text" width={250} className="mt-1" /></div>
        <Skeleton variant="rectangular" width={150} height={38} />
      </div>
      <div className="grid grid-cols-3 gap-6">
        {[1, 2, 3].map((i) => (<Skeleton key={i} variant="rectangular" height={400} />))}
      </div>
    </div>
  );
}

export default function ImageGeneratorPage() {
  const params = useParams();
  const projectId = params.id as string;
  const [editingPrompt, setEditingPrompt] = useState<string | null>(null);
  const [generating, setGenerating] = useState<string | null>(null);
  const [genSuccess, setGenSuccess] = useState(false);
  const [brokenImages, setBrokenImages] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState<number | null>(null);

  const { data: images, loading, refetch } = useData<ImageItem[]>(() =>
    api.get(`/api/projects/${projectId}/images`)
  );

  const handleGenerate = useCallback(async (type: string, prompt?: string) => {
    setGenerating(type);
    try {
      await api.post(`/api/projects/${projectId}/images/generate`, { type, prompt });
      await refetch();
      setGenSuccess(true);
      setTimeout(() => setGenSuccess(false), 3000);
    } catch {
      // silently fail
    } finally {
      setGenerating(null);
    }
  }, [projectId, refetch]);

  const handleGenerateAll = useCallback(async () => {
    for (const type of ["featured", "social", "facebook"]) {
      if (!images?.some((i) => i.type === type && i.status === "generated" && i.url)) {
        setGenerating(type);
        try {
          await api.post(`/api/projects/${projectId}/images/generate`, { type });
          await refetch();
        } catch {}
        setGenerating(null);
      }
    }
  }, [projectId, images, refetch]);

  const handleDelete = useCallback(async (imageId: number) => {
    if (!confirm("Delete this image?")) return;
    setDeleting(imageId);
    try {
      await api.delete(`/api/projects/${projectId}/images/delete`, { imageId });
      await refetch();
    } catch {}
    setDeleting(null);
  }, [projectId, refetch]);

  if (loading) return <ImagesSkeleton />;

  const items = images ?? [];

  return (
    <div className="max-w-[1400px] mx-auto px-10 py-8">
      <div className="flex items-center justify-between mb-10">
        <div>
          <h1 className="text-[38px] font-bold text-text-primary tracking-tight">Image Generator</h1>
          <p className="text-[14px] text-text-secondary mt-1">AI-powered image generation for your content</p>
        </div>
        <Button
          icon={generating ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
          onClick={handleGenerateAll}
          disabled={generating !== null}
        >
          {generating ? "Generating..." : "Generate All"}
        </Button>
      </div>

      {genSuccess && (
        <div className="mb-6 p-4 bg-accent-green/10 border border-accent-green/30 rounded-[12px] flex items-start gap-3">
          <CheckCircle2 size={18} className="text-accent-green shrink-0 mt-0.5" />
          <p className="text-[14px] font-medium text-accent-green">Image generated successfully</p>
        </div>
      )}

      {items.length === 0 ? (
        <EmptyState
          icon={<ImageIcon size={48} />}
          title="No images yet"
          description="Generate AI-powered images for your content using Pollinations AI. Start with a featured image, social graphic, or Facebook image."
          actionLabel="Generate Featured Image"
          onAction={() => handleGenerate("featured")}
        />
      ) : (
        <div className="grid grid-cols-3 gap-6">
          {items.map((img) => {
            const config = imageConfigs[img.type] ?? { title: img.type, icon: <ImageIcon size={20} /> };
            const isGenerating = generating === img.type;

            return (
              <Card key={img.id} padding="lg">
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-10 h-10 rounded-[10px] bg-bg-surface-secondary flex items-center justify-center text-text-secondary">
                    {config.icon}
                  </div>
                  <div>
                    <h3 className="text-[16px] font-semibold text-text-primary">{config.title}</h3>
                    <p className="text-[12px] text-text-secondary">{img.width} x {img.height}</p>
                  </div>
                </div>

                <div className="bg-bg-surface-secondary rounded-[12px] aspect-[1.91/1] mb-4 flex items-center justify-center border border-border-subtle overflow-hidden">
                  {img.url && !brokenImages.has(img.url) ? (
                    <img
                      src={img.url}
                      alt={img.prompt}
                      className="w-full h-full object-cover"
                      onError={() => setBrokenImages((prev) => new Set(prev).add(img.url!))}
                    />
                  ) : brokenImages.has(img.url!) ? (
                    <div className="flex flex-col items-center gap-2 text-text-secondary/40">
                      <ImageIcon size={36} />
                      <span className="text-[11px]">Image failed to load</span>
                    </div>
                  ) : isGenerating ? (
                    <div className="flex flex-col items-center gap-3">
                      <Loader2 size={32} className="text-accent-primary animate-spin" />
                      <span className="text-[12px] text-text-secondary">Generating...</span>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center gap-2 text-text-secondary/20">
                      <ImageIcon size={48} />
                      <span className="text-[12px]">Generate to preview</span>
                    </div>
                  )}
                </div>

                {editingPrompt === String(img.id) ? (
                  <div className="mb-4">
                    <textarea
                      value={img.prompt}
                      onChange={() => {}}
                      className="w-full bg-bg-surface-secondary border border-border-subtle rounded-[10px] px-3.5 py-2.5 text-[13px] text-text-primary focus:outline-none focus:border-accent-primary/50 transition-all resize-none h-24"
                    />
                    <Button variant="ghost" size="sm" className="mt-2" onClick={() => setEditingPrompt(null)}>Done</Button>
                  </div>
                ) : (
                  <p className="text-[13px] text-text-secondary mb-4 leading-relaxed line-clamp-3">{img.prompt}</p>
                )}

                <div className="flex items-center justify-between">
                  <Button variant="ghost" size="sm" icon={<Copy size={14} />} onClick={() => navigator.clipboard.writeText(img.prompt)}>
                    Copy Prompt
                  </Button>
                  <div className="flex items-center gap-1">
                    {!img.url && !isGenerating && (
                      <Button variant="secondary" size="sm" icon={<Sparkles size={14} />} onClick={() => handleGenerate(img.type)}>
                        Generate
                      </Button>
                    )}
                    {img.url && (
                      <>
                        <Button variant="ghost" size="sm" icon={<RefreshCw size={14} />} onClick={() => handleGenerate(img.type)}>
                          Regenerate
                        </Button>
                        <Button variant="ghost" size="sm" icon={<Download size={14} />} onClick={() => {
                          if (img.url) window.open(img.url, "_blank");
                        }}>
                          Download
                        </Button>
                      </>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={deleting === img.id ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                      onClick={() => handleDelete(img.id)}
                      disabled={deleting === img.id}
                    />
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
