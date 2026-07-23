import { headers, cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { projectRepository } from "@/lib/repositories";
import type { Project } from "@/db/schema";
import { AppError } from "./errors";

async function getUserIdFromCookie(): Promise<string | null> {
  try {
    const cookieStore = await cookies();
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return cookieStore.getAll();
          },
          setAll() {},
        },
      }
    );

    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) return null;
    return data.user.id;
  } catch {
    return null;
  }
}

async function getUserIdFromBearer(headersList: Headers): Promise<string | null> {
  const authHeader = headersList.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;

  const token = authHeader.slice(7);
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll() { return []; }, setAll() {} } }
  );

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user.id;
}

export async function resolveAuthenticatedUserId(): Promise<string> {
  const headersList = await headers();

  const bearerId = await getUserIdFromBearer(headersList);
  if (bearerId) return bearerId;

  const cookieId = await getUserIdFromCookie();
  if (cookieId) return cookieId;

  throw AppError.unauthorized();
}

export async function requireProjectAccess(
  userId: string,
  projectId: number,
): Promise<Project> {
  const project = await projectRepository.findByIdAndUser(projectId, userId);
  if (!project) {
    throw AppError.forbidden();
  }
  return project;
}
