import { AppError } from "./errors";

export async function generateImage(prompt: string, width: number = 1200, height: number = 630): Promise<string> {
  const apiKey = process.env.HF_TOKEN;
  if (!apiKey) {
    throw AppError.internal("Image generation service is not configured");
  }

  const model = width <= 512 ? "black-forest-labs/FLUX.1-schnell" : "black-forest-labs/FLUX.1-dev";
  const enhancedPrompt = `${prompt}, professional quality, well-lit, natural colors`;

  const response = await fetch(
    `https://api-inference.huggingface.co/models/${model}`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        inputs: enhancedPrompt,
        parameters: {
          width,
          height,
          guidance_scale: 7.5,
          num_inference_steps: 28,
        },
      }),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    console.error("Hugging Face error:", error.substring(0, 300));
    if (response.status === 503) {
      throw AppError.internal("Image generation service temporarily unavailable", new Error("Model is loading"));
    }
    throw AppError.internal(
      "Image generation failed",
      new Error(`Hugging Face API returned ${response.status}: ${error.substring(0, 200)}`)
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const base64 = buffer.toString("base64");
  return `data:image/png;base64,${base64}`;
}

export async function saveImage(projectId: number, type: string, prompt: string, url: string, width: number, height: number) {
  const { getDb } = await import("@/db");
  const db = getDb() as any;
  const { data, error } = await db
    .from("images")
    .insert({
      project_id: projectId,
      type,
      prompt,
      url,
      status: "generated",
      width,
      height,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

const DEFAULT_PROMPTS: Record<string, { label: string; width: number; height: number }> = {
  featured: { label: "Featured Image", width: 1200, height: 630 },
  social: { label: "Social Image", width: 800, height: 450 },
  facebook: { label: "Facebook Image", width: 400, height: 300 },
};

export function getImageDimensions(type: string) {
  return DEFAULT_PROMPTS[type] ?? { label: type, width: 800, height: 450 };
}
