"use client";

import { useState, useEffect } from "react";
import {
  Eye,
  EyeOff,
  Check,
  Plug,
  Globe,
  Palette,
  Shield,
  Cpu,
  Zap,
  FileText,
  Save,
  RotateCcw,
  RefreshCw,
  AlertCircle,
} from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Skeleton } from "@/components/ui/Skeleton";
import { useData } from "@/lib/use-data";
import { api } from "@/lib/api-client";
import { DEFAULT_PROMPTS } from "@/lib/services/default-prompts";

type TabId =
  | "general"
  | "ai"
  | "wordpress"
  | "seo"
  | "appearance"
  | "security"
  | "prompt-brand"
  | "prompt-seo"
  | "prompt-formatting"
  | "prompt-hongkong"
  | "prompt-structure"
  | "prompt-social"
  | "prompt-images"
  | "prompt-translation"
  | "prompt-cta"
  | "prompt-checklist";

const tabs: { id: TabId; label: string; icon: React.ReactNode }[] = [
  { id: "general", label: "General", icon: <Cpu size={16} /> },
  { id: "ai", label: "AI", icon: <Zap size={16} /> },
  { id: "wordpress", label: "WordPress", icon: <Globe size={16} /> },
  { id: "seo", label: "SEO", icon: <Zap size={16} /> },
  { id: "appearance", label: "Appearance", icon: <Palette size={16} /> },
  { id: "security", label: "Security", icon: <Shield size={16} /> },
  { id: "prompt-brand", label: "Prompt: Brand Voice", icon: <FileText size={16} /> },
  { id: "prompt-seo", label: "Prompt: SEO Rules", icon: <FileText size={16} /> },
  { id: "prompt-formatting", label: "Prompt: Formatting", icon: <FileText size={16} /> },
  { id: "prompt-hongkong", label: "Prompt: HK Context", icon: <FileText size={16} /> },
  { id: "prompt-structure", label: "Prompt: Blog Structure", icon: <FileText size={16} /> },
  { id: "prompt-social", label: "Prompt: Social Rules", icon: <FileText size={16} /> },
  { id: "prompt-images", label: "Prompt: Image Rules", icon: <FileText size={16} /> },
  { id: "prompt-translation", label: "Prompt: Translation", icon: <FileText size={16} /> },
  { id: "prompt-cta", label: "Prompt: CTA Block", icon: <FileText size={16} /> },
  { id: "prompt-checklist", label: "Prompt: Publish Checklist", icon: <FileText size={16} /> },
];

interface Profile {
  id: string;
  fullName: string;
  email?: string;
  role: string;
}

interface PromptSection {
  sectionKey: string;
  content: string;
}

const SECTION_KEY_MAP: Record<string, string> = {
  "prompt-brand": "brand_voice",
  "prompt-seo": "seo_rules",
  "prompt-formatting": "formatting_rules",
  "prompt-hongkong": "hong_kong_context",
  "prompt-structure": "blog_structure",
  "prompt-social": "social_rules",
  "prompt-images": "image_rules",
  "prompt-translation": "translation_rules",
  "prompt-cta": "cta",
  "prompt-checklist": "publish_checklist",
};

function PromptTabContent({
  tabId,
  promptSections,
  promptsLoading,
  refetchPrompts,
}: {
  tabId: string;
  promptSections: PromptSection[] | null;
  promptsLoading: boolean;
  refetchPrompts: () => void;
}) {
  const sectionKey = SECTION_KEY_MAP[tabId];
  const defaultContent = DEFAULT_PROMPTS[sectionKey] ?? "";
  const tabLabel = tabs.find((t) => t.id === tabId)?.label ?? "";

  const [content, setContent] = useState(defaultContent);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);

  useEffect(() => {
    if (promptSections) {
      const section = promptSections.find(
        (s) => s.sectionKey === sectionKey
      );
      if (section) {
        setContent(section.content);
      }
    }
  }, [promptSections, sectionKey]);

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    setSaveError(null);
    try {
      console.log(`[settings:save] POST /api/prompt-sections sectionKey=${sectionKey} contentLen=${content.length}`);
      const result = await api.post("/api/prompt-sections", {
        sectionKey,
        content,
      });
      console.log(`[settings:save] Success:`, result);
      setSaved(true);
      refetchPrompts();
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      console.error(`[settings:save] Error:`, err);
      setSaveError(
        err instanceof Error ? err.message : "Failed to save"
      );
    } finally {
      setSaving(false);
    }
  };

  const handleRestoreDefaults = () => {
    setContent(defaultContent);
    setSaved(false);
    setSaveError(null);
  };

  const handleRefresh = () => {
    if (promptSections) {
      const section = promptSections.find(
        (s) => s.sectionKey === sectionKey
      );
      if (section) {
        console.log(`[settings:refresh] Loaded from DB: ${sectionKey} (${section.content.length} chars)`);
        setContent(section.content);
      } else {
        console.log(`[settings:refresh] No saved section for ${sectionKey}, using default`);
        setContent(defaultContent);
      }
      setSaved(false);
      setSaveError(null);
    }
    refetchPrompts();
  };

  return (
    <Card>
      <h3 className="text-[16px] font-semibold text-text-primary mb-5">
        {tabLabel}
      </h3>

      {promptsLoading ? (
        <Skeleton variant="rectangular" height={300} />
      ) : (
        <>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            className="w-full bg-bg-surface border border-border-subtle rounded-[10px] px-3.5 py-2.5 text-[13px] text-text-primary font-mono focus:outline-none focus:border-accent-primary/50 transition-all resize-y min-h-[300px]"
            rows={16}
          />

          <div className="flex items-center gap-2 mt-4">
            <Button
              onClick={handleSave}
              loading={saving}
              icon={
                saved ? (
                  <Check size={14} className="text-accent-green" />
                ) : (
                  <Save size={14} />
                )
              }
            >
              {saved ? "Saved" : "Save"}
            </Button>
            <Button
              variant="secondary"
              onClick={handleRestoreDefaults}
              icon={<RotateCcw size={14} />}
            >
              Restore Defaults
            </Button>
            <Button
              variant="secondary"
              onClick={handleRefresh}
              icon={<RefreshCw size={14} />}
            >
              Refresh
            </Button>
            <Button
              variant="ghost"
              onClick={() => setShowPreview(!showPreview)}
              icon={<Eye size={14} />}
            >
              Preview Final Prompt
            </Button>
          </div>

          {saveError && (
            <p className="text-[13px] text-accent-danger mt-2 flex items-center gap-1">
              <AlertCircle size={14} /> {saveError}
            </p>
          )}

          {showPreview && (
            <div className="mt-4 p-4 bg-bg-surface-secondary border border-border-subtle rounded-[10px]">
              <pre className="text-[13px] text-text-primary whitespace-pre-wrap font-mono leading-relaxed">
                {content}
              </pre>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState<TabId>("general");
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});
  const [testResults, setTestResults] = useState<Record<string, boolean>>(
    {}
  );

  const { data: profile, loading } = useData<Profile>(() =>
    api.get("/api/profile")
  );

  const { data: promptSections, loading: promptsLoading, refetch: refetchPrompts } =
    useData<PromptSection[]>(() => api.get("/api/prompt-sections"));

  const toggleKey = (key: string) =>
    setShowKeys((prev) => ({ ...prev, [key]: !prev[key] }));

  const testConnection = (service: string) => {
    setTestResults((prev) => ({ ...prev, [service]: true }));
    setTimeout(() => {
      setTestResults((prev) => ({ ...prev, [service]: false }));
    }, 2000);
  };

  return (
    <div className="max-w-[1000px] mx-auto px-10 py-8">
      <h1 className="text-[38px] font-bold text-text-primary tracking-tight mb-2">
        Settings
      </h1>
      <p className="text-[14px] text-text-secondary mb-8">
        Manage your application configuration
      </p>

      <div className="flex gap-8">
        <div className="w-[200px] shrink-0 space-y-0.5">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-[10px] text-[14px] font-medium transition-all duration-150 ${
                activeTab === tab.id
                  ? "bg-accent-primary/10 text-accent-primary"
                  : "text-text-secondary hover:text-text-primary hover:bg-[rgba(255,255,255,0.04)]"
              }`}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </div>

        <div className="flex-1 min-w-0 space-y-6">
          {activeTab === "general" && (
            <>
              <Card>
                <h3 className="text-[16px] font-semibold text-text-primary mb-5">
                  Profile
                </h3>
                <div className="grid grid-cols-2 gap-4">
                  {loading ? (
                    <>
                      <Skeleton variant="rectangular" height={50} />
                      <Skeleton variant="rectangular" height={50} />
                      <Skeleton variant="rectangular" height={50} />
                      <Skeleton variant="rectangular" height={50} />
                    </>
                  ) : (
                    <>
                      <Input
                        label="Display Name"
                        defaultValue={profile?.fullName ?? "User"}
                      />
                      <Input
                        label="Email"
                        defaultValue={profile?.email ?? ""}
                      />
                      <Input label="Company" defaultValue="B2I Digital" />
                      <Input
                        label="Role"
                        defaultValue={profile?.role ?? "Editor"}
                      />
                    </>
                  )}
                </div>
              </Card>

              <Card>
                <h3 className="text-[16px] font-semibold text-text-primary mb-5">
                  Preferences
                </h3>
                <div className="space-y-3">
                  {[
                    {
                      label: "Default Language",
                      value: "English (US)",
                    },
                    {
                      label: "Time Zone",
                      value: "UTC-5 (Eastern)",
                    },
                    {
                      label: "Date Format",
                      value: "MM/DD/YYYY",
                    },
                  ].map((pref) => (
                    <div
                      key={pref.label}
                      className="flex items-center justify-between py-2"
                    >
                      <span className="text-[14px] text-text-secondary">
                        {pref.label}
                      </span>
                      <span className="text-[14px] text-text-primary font-medium">
                        {pref.value}
                      </span>
                    </div>
                  ))}
                </div>
              </Card>
            </>
          )}

          {activeTab === "ai" && (
            <>
              <Card>
                <h3 className="text-[16px] font-semibold text-text-primary mb-5">
                  AI Providers
                </h3>
                <div className="space-y-5">
                  {[
                    {
                      label: "OpenAI API Key",
                      key: "openai",
                      masked: "sk-...A1b2",
                    },
                    {
                      label: "Anthropic API Key",
                      key: "anthropic",
                      masked: "sk-ant-...C3d4",
                    },
                    {
                      label: "Google AI Key",
                      key: "google",
                      masked: "AIza-...E5f6",
                    },
                  ].map((provider) => (
                    <div key={provider.key}>
                      <label className="text-[13px] font-medium text-text-secondary block mb-1.5">
                        {provider.label}
                      </label>
                      <div className="flex items-center gap-2">
                        <div className="relative flex-1">
                          <input
                            type={
                              showKeys[provider.key] ? "text" : "password"
                            }
                            defaultValue={provider.masked}
                            className="w-full bg-bg-surface border border-border-subtle rounded-[10px] px-3.5 py-2.5 pr-10 text-[14px] text-text-primary font-mono focus:outline-none focus:border-accent-primary/50 transition-all"
                          />
                          <button
                            onClick={() => toggleKey(provider.key)}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-text-secondary hover:text-text-primary transition-colors"
                          >
                            {showKeys[provider.key] ? (
                              <EyeOff size={16} />
                            ) : (
                              <Eye size={16} />
                            )}
                          </button>
                        </div>
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled
                          title="Coming in next phase"
                          icon={
                            testResults[provider.key] ? (
                              <Check
                                size={14}
                                className="text-accent-green"
                              />
                            ) : (
                              <Plug size={14} />
                            )
                          }
                          onClick={() => testConnection(provider.key)}
                        >
                          {testResults[provider.key]
                            ? "Connected"
                            : "Test"}
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </Card>

              <Card>
                <h3 className="text-[16px] font-semibold text-text-primary mb-5">
                  Model Settings
                </h3>
                <div className="space-y-3">
                  {[
                    { label: "Default Model", value: "GPT-4o" },
                    { label: "Temperature", value: "0.7" },
                    { label: "Max Tokens", value: "4096" },
                  ].map((setting) => (
                    <div
                      key={setting.label}
                      className="flex items-center justify-between py-2"
                    >
                      <span className="text-[14px] text-text-secondary">
                        {setting.label}
                      </span>
                      <span className="text-[14px] text-text-primary font-medium">
                        {setting.value}
                      </span>
                    </div>
                  ))}
                </div>
              </Card>
            </>
          )}

          {activeTab === "wordpress" && (
            <Card>
              <h3 className="text-[16px] font-semibold text-text-primary mb-5">
                WordPress Connection
              </h3>
              <div className="space-y-4">
                <Input
                  label="Site URL"
                  defaultValue="https://b2i.com"
                />
                <Input label="Username" defaultValue="admin" />
                <div>
                  <label className="text-[13px] font-medium text-text-secondary block mb-1.5">
                    Application Password
                  </label>
                  <div className="flex items-center gap-2">
                    <div className="relative flex-1">
                      <input
                        type="password"
                        defaultValue="••••••••••••••••"
                        className="w-full bg-bg-surface border border-border-subtle rounded-[10px] px-3.5 py-2.5 text-[14px] text-text-primary font-mono focus:outline-none focus:border-accent-primary/50 transition-all"
                      />
                    </div>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled
                      title="Coming in next phase"
                      icon={
                        testResults["wp"] ? (
                          <Check
                            size={14}
                            className="text-accent-green"
                          />
                        ) : (
                          <Plug size={14} />
                        )
                      }
                      onClick={() => testConnection("wp")}
                    >
                      {testResults["wp"] ? "Connected" : "Test Connection"}
                    </Button>
                  </div>
                </div>
              </div>
            </Card>
          )}

          {activeTab === "seo" && (
            <Card>
              <h3 className="text-[16px] font-semibold text-text-primary mb-5">
                SEO Defaults
              </h3>
              <div className="space-y-4">
                <Input
                  label="Default Meta Template"
                  defaultValue="{title} | B2I Digital"
                />
                <Input
                  label="Default Author"
                  defaultValue="Sean Adams"
                />
                <div className="flex flex-col gap-1.5">
                  <label className="text-[13px] font-medium text-text-secondary">
                    Default Schema Type
                  </label>
                  <select className="bg-bg-surface border border-border-subtle rounded-[10px] px-3.5 py-2.5 text-[14px] text-text-primary focus:outline-none focus:border-accent-primary/50 transition-all">
                    <option>Article</option>
                    <option>BlogPosting</option>
                    <option>HowTo</option>
                    <option>FAQ</option>
                  </select>
                </div>
              </div>
            </Card>
          )}

          {activeTab === "appearance" && (
            <Card>
              <h3 className="text-[16px] font-semibold text-text-primary mb-5">
                Theme
              </h3>
              <div className="space-y-3">
                {[
                  { label: "Theme", value: "Dark" },
                  { label: "Font Size", value: "Medium" },
                  {
                    label: "Sidebar",
                    value: "Expanded by default",
                  },
                ].map((setting) => (
                  <div
                    key={setting.label}
                    className="flex items-center justify-between py-2"
                  >
                    <span className="text-[14px] text-text-secondary">
                      {setting.label}
                    </span>
                    <span className="text-[14px] text-text-primary font-medium">
                      {setting.value}
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {activeTab === "security" && (
            <Card>
              <h3 className="text-[16px] font-semibold text-text-primary mb-5">
                Security Settings
              </h3>
              <div className="space-y-4">
                <Input
                  label="Current Password"
                  type="password"
                  defaultValue="••••••••••"
                />
                <Input
                  label="New Password"
                  type="password"
                  placeholder="Enter new password"
                />
                <Input
                  label="Confirm Password"
                  type="password"
                  placeholder="Confirm new password"
                />
                <div className="pt-2">
                  <Button>Update Password</Button>
                </div>
              </div>

              <div className="mt-6 pt-6 border-t border-border-subtle">
                <h3 className="text-[16px] font-semibold text-text-primary mb-5">
                  Two-Factor Authentication
                </h3>
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-[14px] text-text-primary font-medium">
                      2FA is enabled
                    </p>
                    <p className="text-[13px] text-text-secondary mt-0.5">
                      Your account is protected with two-factor
                      authentication
                    </p>
                  </div>
                  <Button variant="danger" size="sm">
                    Disable
                  </Button>
                </div>
              </div>
            </Card>
          )}

          {activeTab.startsWith("prompt-") && (
            <PromptTabContent
              tabId={activeTab}
              promptSections={promptSections}
              promptsLoading={promptsLoading}
              refetchPrompts={refetchPrompts}
            />
          )}
        </div>
      </div>
    </div>
  );
}
