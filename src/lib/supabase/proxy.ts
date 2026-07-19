import { createServerClient } from "@supabase/ssr";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export async function updateSession(request: NextRequest) {
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            request.cookies.set({ name, value, ...options });
          });
        },
      },
    }
  );

  const { data: { user } } = await supabase.auth.getUser();

  const protectedPaths = [
    "/projects",
    "/knowledge",
    "/prompts",
    "/settings",
    "/api/projects",
    "/api/knowledge",
    "/api/prompts",
    "/api/dashboard",
    "/api/profile",
  ];

  const isProtected = protectedPaths.some(
    (path) =>
      request.nextUrl.pathname === path ||
      request.nextUrl.pathname.startsWith(path + "/")
  );

  if (!user && isProtected) {
    const url = request.nextUrl.clone();
    url.pathname = "/auth/login";
    return NextResponse.redirect(url);
  }

  const requestHeaders = new Headers(request.headers);
  if (user) {
    requestHeaders.set("x-user-id", user.id);
  }

  return NextResponse.next({
    request: { headers: requestHeaders },
  });
}
