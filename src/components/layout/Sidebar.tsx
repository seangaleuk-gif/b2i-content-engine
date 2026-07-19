"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  LayoutDashboard,
  FolderOpen,
  BookOpen,
  FileText,
  Settings,
  ChevronLeft,
  ChevronRight,
  HardDrive,
  Zap,
  Cpu,
  LogOut,
} from "lucide-react";
import { useData } from "@/lib/use-data";
import { api } from "@/lib/api-client";
import { Skeleton } from "@/components/ui/Skeleton";

const primaryItems = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/projects", label: "Projects", icon: FolderOpen },
  { href: "/knowledge", label: "Knowledge", icon: BookOpen },
  { href: "/prompts", label: "Prompt Library", icon: FileText },
  { href: "/settings", label: "Settings", icon: Settings },
];

interface Profile {
  id: string;
  fullName: string;
  avatarUrl: string | null;
  role: string;
  apiCreditsUsed: number;
  apiCreditsLimit: number;
  storageUsedBytes: number;
  storageLimitBytes: number;
}

export function Sidebar() {
  const [expanded, setExpanded] = useState(true);
  const pathname = usePathname();
  const router = useRouter();

  const { data: profile, loading: profileLoading } = useData<Profile>(() =>
    api.get("/api/profile")
  );

  const apiPct = profile
    ? Math.round((profile.apiCreditsUsed / profile.apiCreditsLimit) * 100)
    : 0;
  const storagePct = profile
    ? Math.round((profile.storageUsedBytes / profile.storageLimitBytes) * 100)
    : 0;

  const getInitials = (name?: string) =>
    (name || "U")
      .split(" ")
      .map((n) => n[0])
      .join("")
      .toUpperCase()
      .slice(0, 2);

  const handleSignOut = async () => {
    await fetch("/auth/signout", { method: "POST" });
    router.push("/auth/login");
  };

  return (
    <aside
      className={`h-full bg-bg-surface border-r border-border-subtle flex flex-col shrink-0 transition-all duration-200 ${
        expanded ? "w-[260px]" : "w-[80px]"
      }`}
    >
      <div className="flex items-center h-16 px-5 border-b border-border-subtle shrink-0">
        {expanded ? (
          <span className="text-[18px] font-bold text-text-primary tracking-tight">
            B2I Content<span className="text-accent-primary"> Engine</span>
          </span>
        ) : (
          <span className="text-[18px] font-bold text-accent-primary mx-auto">
            B2
          </span>
        )}
      </div>

      <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">
        {primaryItems.map((item) => {
          const Icon = item.icon;
          const active = pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href));
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center rounded-[10px] transition-all duration-150 group ${
                expanded ? "px-3 py-2.5 gap-3" : "px-0 py-2.5 justify-center"
              } ${
                active
                  ? "bg-accent-primary/10 text-accent-primary"
                  : "text-text-secondary hover:text-text-primary hover:bg-[rgba(255,255,255,0.04)]"
              }`}
            >
              <Icon
                className={`shrink-0 ${
                  active ? "text-accent-primary" : "text-text-secondary group-hover:text-text-primary"
                }`}
                size={20}
              />
              {expanded && (
                <span className="text-[14px] font-medium">{item.label}</span>
              )}
            </Link>
          );
        })}

        <div className="pt-4 mt-4 border-t border-border-subtle">
          <div className={`${expanded ? "px-3" : "px-0"} text-[11px] font-semibold text-text-secondary/60 uppercase tracking-widest ${expanded ? "mb-2" : "text-center mb-1"}`}>
            System Status
          </div>

          {[
            {
              label: "API Usage",
              icon: Zap,
              value: profile
                ? `${(profile.apiCreditsUsed / 1000).toFixed(1)}k / ${(profile.apiCreditsLimit / 1000).toFixed(0)}k`
                : "--",
              pct: apiPct,
            },
            {
              label: "Storage",
              icon: HardDrive,
              value: profile
                ? `${(profile.storageUsedBytes / 1073741824).toFixed(1)} / ${(profile.storageLimitBytes / 1073741824).toFixed(0)} GB`
                : "--",
              pct: storagePct,
            },
            { label: "CPU Load", icon: Cpu, value: "12%", pct: 12 },
          ].map((stat) => {
            const StatIcon = stat.icon;
            return (
              <div
                key={stat.label}
                className={`flex items-center rounded-[10px] transition-colors ${
                  expanded ? "px-3 py-2 gap-3" : "px-0 py-2 justify-center"
                }`}
              >
                <StatIcon size={16} className="text-text-secondary shrink-0" />
                {expanded && (
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[12px] text-text-secondary">
                        {stat.label}
                      </span>
                      {profileLoading ? (
                        <Skeleton variant="text" width={60} />
                      ) : (
                        <span className="text-[12px] text-text-primary font-medium">
                          {stat.value}
                        </span>
                      )}
                    </div>
                    <div className="h-1 bg-bg-surface-secondary rounded-full overflow-hidden">
                      <div
                        className="h-full bg-accent-primary rounded-full transition-all duration-500"
                        style={{ width: `${stat.pct}%` }}
                      />
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </nav>

      <div className="p-3 border-t border-border-subtle shrink-0">
        <div
          className={`flex items-center rounded-[10px] p-2.5 ${
            expanded ? "gap-3" : "justify-center"
          }`}
        >
          {profileLoading ? (
            <Skeleton variant="circular" width={32} height={32} />
          ) : (
            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-accent-primary to-[#7C3AED] flex items-center justify-center text-[12px] font-bold text-white shrink-0">
              {profile ? getInitials(profile.fullName) : "?"}
            </div>
          )}
          {expanded && (
            <div className="flex-1 min-w-0">
              {profileLoading ? (
                <div className="space-y-1">
                  <Skeleton variant="text" width={100} />
                  <Skeleton variant="text" width={60} />
                </div>
              ) : (
                <>
                  <p className="text-[13px] font-medium text-text-primary truncate">
                    {profile?.fullName ?? "User"}
                  </p>
                  <p className="text-[11px] text-text-secondary">
                    {profile?.role ?? "Editor"}
                  </p>
                </>
              )}
            </div>
          )}
        </div>
        <div className={`flex items-center mt-2 ${expanded ? "justify-between" : "justify-center"}`}>
          {expanded && (
            <span className="text-[11px] text-text-secondary/50">v1.2.4</span>
          )}
          <div className="flex items-center gap-1">
            <button
              onClick={handleSignOut}
              className="p-1.5 rounded-lg hover:bg-[rgba(255,255,255,0.06)] text-text-secondary hover:text-text-primary transition-all"
              title="Sign out"
            >
              <LogOut size={14} />
            </button>
            <button
              onClick={() => setExpanded(!expanded)}
              className="p-1.5 rounded-lg hover:bg-[rgba(255,255,255,0.06)] text-text-secondary hover:text-text-primary transition-all"
            >
              {expanded ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}
