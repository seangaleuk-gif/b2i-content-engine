export function cleanBodyText(text: string): string {
  return text
    .replace(/<!--\s*wp:html\s*-->[\s\S]*?<!--\s*\/wp:html\s*-->/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/[\[\]\(\)#*_~`>|]/g, " ")
    .replace(/\{.*?\}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function countWords(text: string): number {
  const cleaned = cleanBodyText(text);
  return cleaned ? cleaned.split(/\s+/).length : 0;
}

export function splitSentences(text: string): string[] {
  return cleanBodyText(text)
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 10);
}

export function robustJsonParse(raw: string): unknown {
  // Direct parse
  try { return JSON.parse(raw); } catch { /* proceed */ }

  // Extract from markdown code blocks
  const codeBlock = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (codeBlock) {
    try { return JSON.parse(codeBlock[1].trim()); } catch { /* proceed */ }
  }

  // Find outermost JSON object
  const objMatch = raw.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try { return JSON.parse(objMatch[0]); } catch {
      // Repair trailing commas before closing brackets/braces
      const repaired = objMatch[0].replace(/,(\s*[}\]])/g, "$1");
      try { return JSON.parse(repaired); } catch { /* proceed */ }
    }
  }

  throw new Error("Failed to parse JSON response from AI");
}

export function repairMetaDescription(meta: string, min: number, max: number): string {
  if (meta.length >= min && meta.length <= max) return meta;

  if (meta.length < min) {
    const suffix = " Learn more at B2I Hub.";
    const candidate = meta + suffix;
    if (candidate.length <= max) return candidate;
    return meta + " Discover more at B2I Hub.";
  }

  const truncated = meta.substring(0, max);
  const lastPeriod = truncated.lastIndexOf(".");
  if (lastPeriod > min) return truncated.substring(0, lastPeriod + 1);
  const lastSpace = truncated.lastIndexOf(" ");
  return lastSpace > 0 ? truncated.substring(0, lastSpace) + "\u2026" : truncated + "\u2026";
}
