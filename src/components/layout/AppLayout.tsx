"use client";

import { usePathname } from "next/navigation";
import { Sidebar } from "./Sidebar";

export function AppLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isAuthPage = pathname.startsWith("/auth");

  if (isAuthPage) {
    return <main className="flex-1 overflow-y-auto">{children}</main>;
  }

  return (
    <>
      <Sidebar />
      <main className="flex-1 overflow-y-auto">{children}</main>
    </>
  );
}
