"use client";

import { useState, useCallback } from "react";
import { useParams } from "next/navigation";
import {
  BookOpen,
  Plus,
  Trash2,
  Save,
  GripVertical,
  Loader2,
  CheckCircle2,
} from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { useData } from "@/lib/use-data";
import { api } from "@/lib/api-client";

interface OutlineBullet {
  id: string;
  text: string;
}

interface OutlineSection {
  id: string;
  title: string;
  bullets: OutlineBullet[];
}

interface Project {
  id: number;
  content: string;
}

let sectionCounter = 0;
let bulletCounter = 0;

function generateSectionId(): string {
  sectionCounter++;
  return `section-${Date.now()}-${sectionCounter}`;
}

function generateBulletId(): string {
  bulletCounter++;
  return `bullet-${Date.now()}-${bulletCounter}`;
}

function parseOutlineFromContent(content: string): OutlineSection[] {
  const sections: OutlineSection[] = [];
  const lines = content.split("\n");
  let currentSection: OutlineSection | null = null;

  for (const line of lines) {
    if (line.startsWith("## ")) {
      if (currentSection) {
        sections.push(currentSection);
      }
      currentSection = {
        id: generateSectionId(),
        title: line.replace(/^##\s+/, ""),
        bullets: [],
      };
    } else if (line.startsWith("### ") && currentSection) {
      currentSection.bullets.push({
        id: generateBulletId(),
        text: line.replace(/^###\s+/, ""),
      });
    }
  }

  if (currentSection) {
    sections.push(currentSection);
  }

  return sections;
}

function serializeOutlineToContent(sections: OutlineSection[]): string {
  return sections
    .map((section) => {
      let result = `## ${section.title}`;
      if (section.bullets.length > 0) {
        result +=
          "\n" +
          section.bullets.map((b) => `### ${b.text}`).join("\n");
      }
      return result;
    })
    .join("\n\n");
}

function OutlineSkeleton() {
  return (
    <div className="max-w-[1400px] mx-auto px-10 py-8">
      <div className="flex items-center justify-between mb-10">
        <div>
          <Skeleton variant="text" width={250} height={38} />
          <Skeleton variant="text" width={250} className="mt-1" />
        </div>
        <Skeleton variant="rectangular" width={130} height={38} />
      </div>
      <div className="space-y-4">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} variant="rectangular" height={150} />
        ))}
      </div>
    </div>
  );
}

export default function OutlinePage() {
  const params = useParams();
  const projectId = params.id as string;
  const [sections, setSections] = useState<OutlineSection[]>([]);
  const [initialized, setInitialized] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const { data: project, loading } = useData<Project>(
    () => api.get(`/api/projects/${projectId}`)
  );

  if (!initialized && project && !loading) {
    if (project.content) {
      setSections(parseOutlineFromContent(project.content));
    }
    setInitialized(true);
  }

  const addSection = useCallback(() => {
    setSections((prev) => [
      ...prev,
      { id: generateSectionId(), title: "", bullets: [] },
    ]);
    setSaved(false);
  }, []);

  const removeSection = useCallback((id: string) => {
    setSections((prev) => prev.filter((s) => s.id !== id));
    setSaved(false);
  }, []);

  const updateSectionTitle = useCallback((id: string, title: string) => {
    setSections((prev) =>
      prev.map((s) => (s.id === id ? { ...s, title } : s))
    );
    setSaved(false);
  }, []);

  const addBullet = useCallback((sectionId: string) => {
    setSections((prev) =>
      prev.map((s) =>
        s.id === sectionId
          ? {
              ...s,
              bullets: [
                ...s.bullets,
                { id: generateBulletId(), text: "" },
              ],
            }
          : s
      )
    );
    setSaved(false);
  }, []);

  const removeBullet = useCallback(
    (sectionId: string, bulletId: string) => {
      setSections((prev) =>
        prev.map((s) =>
          s.id === sectionId
            ? {
                ...s,
                bullets: s.bullets.filter(
                  (b) => b.id !== bulletId
                ),
              }
            : s
        )
      );
      setSaved(false);
    },
    []
  );

  const updateBulletText = useCallback(
    (sectionId: string, bulletId: string, text: string) => {
      setSections((prev) =>
        prev.map((s) =>
          s.id === sectionId
            ? {
                ...s,
                bullets: s.bullets.map((b) =>
                  b.id === bulletId ? { ...b, text } : b
                ),
              }
            : s
        )
      );
      setSaved(false);
    },
    []
  );

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const content = serializeOutlineToContent(sections);
      await api.patch(`/api/projects/${projectId}`, {
        content,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch {
      // silently fail
    } finally {
      setSaving(false);
    }
  }, [projectId, sections]);

  if (loading) return <OutlineSkeleton />;

  return (
    <div className="max-w-[1400px] mx-auto px-10 py-8">
      <div className="flex items-center justify-between mb-10">
        <div>
          <h1 className="text-[38px] font-bold text-text-primary tracking-tight">
            Content Outline
          </h1>
          <p className="text-[14px] text-text-secondary mt-1">
            {sections.length > 0
              ? `${sections.length} section${sections.length !== 1 ? "s" : ""} planned`
              : "Plan your article structure"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {saved && (
            <span className="text-[13px] text-accent-green flex items-center gap-1.5">
              <CheckCircle2 size={14} />
              Saved
            </span>
          )}
          <Button
            icon={
              saving ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <Save size={16} />
              )
            }
            onClick={handleSave}
            disabled={saving || sections.length === 0}
          >
            {saving ? "Saving..." : "Save Outline"}
          </Button>
        </div>
      </div>

      {sections.length === 0 ? (
        <EmptyState
          icon={<BookOpen size={48} />}
          title="No outline yet"
          description="Create your content structure. Add H2 sections to organize your article, then add H3 bullet points for each section."
          actionLabel="Add Section"
          onAction={addSection}
        />
      ) : (
        <div className="space-y-4">
          {sections.map((section, sectionIndex) => (
            <Card key={section.id} padding="lg">
              <div className="flex items-center gap-3 mb-4">
                <div className="text-text-secondary/30">
                  <GripVertical size={18} />
                </div>
                <div className="w-8 h-8 rounded-full bg-accent-primary/10 text-accent-primary flex items-center justify-center text-[13px] font-bold shrink-0">
                  {sectionIndex + 1}
                </div>
                <input
                  value={section.title}
                  onChange={(e) =>
                    updateSectionTitle(section.id, e.target.value)
                  }
                  placeholder="Section heading (H2)"
                  className="flex-1 bg-bg-surface border border-border-subtle rounded-[10px] px-3.5 py-2.5 text-[16px] font-semibold text-text-primary placeholder:text-text-secondary/50 focus:outline-none focus:border-accent-primary/50 focus:ring-1 focus:ring-accent-primary/20 transition-all"
                />
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<Trash2 size={14} />}
                  onClick={() => removeSection(section.id)}
                />
              </div>

              <div className="ml-[66px] space-y-2">
                {section.bullets.map((bullet) => (
                  <div
                    key={bullet.id}
                    className="flex items-center gap-2"
                  >
                    <span className="text-text-secondary/40 text-[18px] select-none">
                      -
                    </span>
                    <input
                      value={bullet.text}
                      onChange={(e) =>
                        updateBulletText(
                          section.id,
                          bullet.id,
                          e.target.value
                        )
                      }
                      placeholder="Bullet point (H3 topic)"
                      className="flex-1 bg-bg-surface border border-border-subtle rounded-[10px] px-3.5 py-2 text-[14px] text-text-primary placeholder:text-text-secondary/50 focus:outline-none focus:border-accent-primary/50 focus:ring-1 focus:ring-accent-primary/20 transition-all"
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<Trash2 size={12} />}
                      onClick={() =>
                        removeBullet(section.id, bullet.id)
                      }
                    />
                  </div>
                ))}
                <button
                  onClick={() => addBullet(section.id)}
                  className="flex items-center gap-2 text-[13px] text-text-secondary hover:text-text-primary transition-colors cursor-pointer py-1"
                >
                  <Plus size={14} />
                  Add bullet point
                </button>
              </div>
            </Card>
          ))}

          <button
            onClick={addSection}
            className="w-full py-4 border-2 border-dashed border-border-subtle rounded-[12px] text-[14px] text-text-secondary hover:text-text-primary hover:border-[rgba(255,255,255,0.1)] transition-all cursor-pointer flex items-center justify-center gap-2"
          >
            <Plus size={16} />
            Add Section
          </button>
        </div>
      )}
    </div>
  );
}
