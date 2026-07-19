"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import {
  Copy,
  Sparkles,
  RefreshCw,
  Hash,
  Type,
  MessageCircle,
  Globe,
  Briefcase,
  AtSign,
  Mail,
  Share2,
} from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { useData } from "@/lib/use-data";
import { api } from "@/lib/api-client";

interface SocialPost {
  id: number;
  platform: string;
  content: string;
  characterCount: number;
  hashtags: string[];
  status: string;
}

const platformConfig: Record<string, { icon: React.ReactNode; characterLimit: number }> = {
  threads: { icon: <MessageCircle size={20} />, characterLimit: 500 },
  facebook: { icon: <Globe size={20} />, characterLimit: 63206 },
  linkedin: { icon: <Briefcase size={20} />, characterLimit: 3000 },
  instagram: { icon: <AtSign size={20} />, characterLimit: 2200 },
  newsletter: { icon: <Mail size={20} />, characterLimit: 0 },
};

function SocialSkeleton() {
  return (
    <div className="max-w-[1400px] mx-auto px-10 py-8">
      <div className="flex items-center justify-between mb-10">
        <div>
          <Skeleton variant="text" width={250} height={38} />
          <Skeleton variant="text" width={250} className="mt-1" />
        </div>
        <Skeleton variant="rectangular" width={150} height={38} />
      </div>
      <div className="grid grid-cols-2 gap-4">
        {[1, 2, 3, 4].map((i) => (
          <Skeleton key={i} variant="rectangular" height={250} />
        ))}
      </div>
    </div>
  );
}

export default function SocialGeneratorPage() {
  const params = useParams();
  const projectId = params.id as string;

  const { data: posts, loading } = useData<SocialPost[]>(() =>
    api.get(`/api/projects/${projectId}/social`)
  );

  if (loading) return <SocialSkeleton />;

  const items = posts ?? [];

  const wordCount = (text: string) =>
    text ? text.split(/\s+/).filter(Boolean).length : 0;

  const charCount = (text: string) => (text ? text.length : 0);

  return (
    <div className="max-w-[1400px] mx-auto px-10 py-8">
      <div className="flex items-center justify-between mb-10">
        <div>
          <h1 className="text-[38px] font-bold text-text-primary tracking-tight">
            Social Generator
          </h1>
          <p className="text-[14px] text-text-secondary mt-1">
            Generate social media posts for every platform
          </p>
        </div>
        <Button icon={<Sparkles size={16} />} disabled title="Coming soon">
          Generate All
        </Button>
      </div>

      {items.length === 0 ? (
        <EmptyState
          icon={<Share2 size={48} />}
          title="No social posts yet"
          description="Generate platform-specific social media content from your blog posts with one click."
          actionLabel="Generate Posts"
          onAction={() => alert("Social post generation coming soon")}
        />
      ) : (
        <div className="grid grid-cols-2 gap-4">
          {items.map((post) => {
            const config = platformConfig[post.platform];
            const hasContent = post.content && post.content.trim().length > 0;

            return (
              <Card key={post.id} padding="lg">
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-10 h-10 rounded-[10px] bg-bg-surface-secondary flex items-center justify-center text-text-secondary">
                    {config?.icon ?? <Globe size={20} />}
                  </div>
                  <div>
                    <h3 className="text-[16px] font-semibold text-text-primary capitalize">
                      {post.platform}
                    </h3>
                    {config && config.characterLimit > 0 && (
                      <p className="text-[12px] text-text-secondary">
                        Limit: {config.characterLimit.toLocaleString()} chars
                      </p>
                    )}
                  </div>
                </div>

                {hasContent ? (
                  <>
                    <div className="bg-bg-surface-secondary rounded-[12px] p-4 mb-4 min-h-[120px]">
                      <pre className="text-[14px] text-text-primary font-sans whitespace-pre-wrap leading-relaxed">
                        {post.content}
                      </pre>
                    </div>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <span className="text-[12px] text-text-secondary flex items-center gap-1">
                          <Type size={12} />
                          {wordCount(post.content)} words
                        </span>
                        <span className="text-[12px] text-text-secondary flex items-center gap-1">
                          <Hash size={12} />
                          {charCount(post.content)} chars
                        </span>
                        {config && config.characterLimit > 0 &&
                          charCount(post.content) > config.characterLimit && (
                            <span className="text-[12px] text-accent-danger">
                              Over limit
                            </span>
                          )}
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          icon={<Copy size={14} />}
                          onClick={() => navigator.clipboard.writeText(post.content)}
                        >
                          Copy
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          icon={<RefreshCw size={14} />}
                          disabled
                          title="Coming soon"
                        >
                          Regenerate
                        </Button>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="flex flex-col items-center justify-center py-12 text-center">
                    <p className="text-[13px] text-text-secondary mb-4">
                      Ready to generate {post.platform} content
                    </p>
                    <Button
                      variant="secondary"
                      icon={<Sparkles size={14} />}
                      disabled
                      title="Coming soon"
                    >
                      Generate
                    </Button>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
