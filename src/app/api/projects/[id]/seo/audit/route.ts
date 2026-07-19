import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/services/auth";
import { projectRepository, seoRepository, blogVersionRepository } from "@/lib/repositories";
import { runAudit } from "@/lib/services/seo-auditor";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const userId = await getCurrentUserId();
    const { id } = await params;
    const project = await projectRepository.findByIdAndUser(Number(id), userId);

    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const body = await request.json();
    const latestVersion = await blogVersionRepository.findLatest(Number(id));

    console.log(`[seo:audit] latestVersion found: ${!!latestVersion}`);
    console.log(`[seo:audit] latestVersion keys: ${latestVersion ? Object.keys(latestVersion as object).join(", ") : "N/A"}`);
    console.log(`[seo:audit] latestVersion.meta_description: "${(latestVersion as any)?.meta_description}"`);
    console.log(`[seo:audit] body.metaDescription: "${body.metaDescription}"`);

    const title = body.title || (latestVersion as any)?.title || project.name || "";
    const metaDescription = (latestVersion as any)?.meta_description || body.metaDescription || "";
    const keyword = body.keyword || (project as any).keyword || "";
    const blog = (latestVersion as any)?.blog || body.blog || (project as any).content || "";

    console.log(`[seo:audit] RESOLVED — title: "${title.substring(0, 60)}..." metaDescription: "${metaDescription.substring(0, 60)}..." metaLen: ${metaDescription.length} blogLen: ${blog.length}`);

    if (!blog) {
      return NextResponse.json({ error: "No blog content to audit" }, { status: 400 });
    }

    const result = runAudit({
      title,
      metaDescription,
      slug: body.slug || "",
      keyword,
      blog,
      externalLinks: (latestVersion as any)?.external_links ?? [],
    });

    // Delete old checks
    await seoRepository.deleteByProject(Number(id));
    console.log(`[seo:audit] Deleted old checks for project ${id}`);

    // Insert new checks
    const inserted = await seoRepository.createMany(
      result.checks.map((c) => ({
        projectId: Number(id),
        label: c.label,
        description: c.description,
        status: c.status,
        score: c.score,
        fix: c.fix,
        category: c.category,
      }))
    );
    console.log(`[seo:audit] Inserted ${inserted.length} checks for project ${id}`);

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    console.error("[seo:audit]", error);
    if (error instanceof Error && error.message === "Not authenticated") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json(
      { error: "Failed to run SEO audit", detail: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const userId = await getCurrentUserId();
    const { id } = await params;
    const project = await projectRepository.findByIdAndUser(Number(id), userId);

    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    await seoRepository.deleteByProject(Number(id));
    console.log(`[seo:audit] Deleted all checks for project ${id}`);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[seo:audit:DELETE]", error);
    if (error instanceof Error && error.message === "Not authenticated") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json(
      { error: "Failed to delete SEO checks" },
      { status: 500 }
    );
  }
}
