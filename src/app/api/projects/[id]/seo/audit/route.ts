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
    const auditRunId = body._auditRunId || "unknown";
    console.log(`[SEO-AUDIT:${auditRunId}:api-input] keywordLen=${(body.keyword || "").length} blogLen=${(body.blog || "").length}`);
    const latestVersion = await blogVersionRepository.findLatest(Number(id));

    // Build immutable audit snapshot from latest saved version only
    const title = (latestVersion as any)?.title || body.title || project.name || "";
    const metaDescription = (latestVersion as any)?.meta_description || body.metaDescription || "";
    // Explicit keyword resolution — priority: client body, then project DB
    const clientKeyword = typeof body.keyword === "string" ? body.keyword.trim() : "";
    const projectKeyword = typeof project.keyword === "string" ? project.keyword.trim() : "";
    const keyword = clientKeyword || projectKeyword;

    console.log(`[KEYPHRASE-RESOLVE] client="${clientKeyword}" project="${projectKeyword}" resolved="${keyword}" len=${keyword.length}`);

    if (!keyword) {
      console.warn("[seo:audit] No focus keyphrase available — marking keyphrase checks as not_applicable");
    }
    const blog = (latestVersion as any)?.blog || body.blog || (project as any).content || "";
    const faq = (latestVersion as any)?.faq || [];
    const targetWordCount = (project as any).wordCount || (project as any).word_count || 2500;
    const targetKeyphraseCount = 5;

    console.log(`[seo:audit] versionId=${(latestVersion as any)?.id} blogLen=${blog.length} title="${title.substring(0, 50)}..." metaLen=${metaDescription.length} keyword="${keyword}"`);

    if (!blog) {
      return NextResponse.json({ error: "No blog content to audit" }, { status: 400 });
    }

    const result = runAudit({
      title,
      metaDescription,
      keyword,
      blog,
      faq,
      targetWordCount,
      targetKeyphraseCount,
    });

    // Delete old checks
    await seoRepository.deleteByProject(Number(id));
    console.log(`[seo:audit] Deleted old checks for project ${id}`);

    // Insert new checks
    const inserted = await seoRepository.createMany(
      result.checks.map((c) => ({
        projectId: Number(id),
        label: c.label,
        description: `${c.measuredValue} (target: ${c.targetValue}) — ${c.explanation}`,
        status: c.status,
        score: c.score,
        fix: c.status !== "not_applicable" ? c.explanation : "",
        category: c.category,
      }))
    );
    console.log(`[seo:audit] Inserted ${inserted.length} checks for project ${id}`);

    const kpCheck = result.checks.find((c) => c.id === "keyphrase_count");
    console.log(`[SEO-AUDIT:${auditRunId}:api-response] overallScore=${result.overallScore} kpStatus=${kpCheck?.status} kpScore=${kpCheck?.score} kpMeasured="${kpCheck?.measuredValue}"`);

    return NextResponse.json({ ...result, _auditRunId: auditRunId, _engineVersion: "keyphrase-fix-1" }, { status: 201 });
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
