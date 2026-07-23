import { getCurrentUserId } from "@/lib/services/auth";
import { projectRepository } from "@/lib/repositories";
import type { Project } from "@/db/schema";
import { AppError } from "./errors";

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
