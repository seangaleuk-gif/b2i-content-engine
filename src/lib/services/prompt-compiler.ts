import { buildSystemPrompt, STAGE_SYSTEM_PROMPTS, type BlogContext } from "@/lib/services/prompt-builder";

export interface PromptBundle {
  readonly outlineSystem: string;
  readonly introSystem: string;
  readonly sectionSystem: string;
  readonly faqSystem: string;
  readonly conclusionSystem: string;
}

// ── Deterministic cache key ──

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return h;
}

function buildCacheKey(context: BlogContext): string {
  const sections = context.promptSections
    .map((s) => `${s.key}:${hashString(s.content)}`)
    .sort()
    .join("|");
  return `p${context.project.name}|${sections}`;
}

// ── LRU cache ──

class PromptCache {
  private cache = new Map<string, PromptBundle>();
  private order: string[] = [];
  private hits = 0;
  private misses = 0;
  private readonly max = 100;

  get(key: string): PromptBundle | null {
    const bundle = this.cache.get(key);
    if (bundle) {
      this.hits++;
      this.order = this.order.filter((k) => k !== key);
      this.order.push(key);
      return bundle;
    }
    this.misses++;
    return null;
  }

  set(key: string, bundle: PromptBundle): void {
    this.order = this.order.filter((k) => k !== key);
    this.order.push(key);
    this.cache.set(key, bundle);

    while (this.cache.size > this.max) {
      const evict = this.order.shift();
      if (evict) this.cache.delete(evict);
    }
  }

  getStats(): { hits: number; misses: number; size: number; hitRate: number } {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      size: this.cache.size,
      hitRate: total > 0 ? Math.round((this.hits / total) * 100) : 0,
    };
  }
}

const globalCache = new PromptCache();

// ── Compiler ──

function compile(context: BlogContext): PromptBundle {
  return Object.freeze({
    outlineSystem: buildSystemPrompt(context, STAGE_SYSTEM_PROMPTS.outline),
    introSystem: buildSystemPrompt(context, STAGE_SYSTEM_PROMPTS.introduction),
    sectionSystem: buildSystemPrompt(context, STAGE_SYSTEM_PROMPTS.section),
    faqSystem: buildSystemPrompt(context, STAGE_SYSTEM_PROMPTS.faq),
    conclusionSystem: buildSystemPrompt(context, STAGE_SYSTEM_PROMPTS.conclusion),
  });
}

export interface CompileResult {
  bundle: PromptBundle;
  cacheHit: boolean;
  compileTimeMs: number;
}

export function getCompiledBundle(context: BlogContext): CompileResult {
  const key = buildCacheKey(context);
  const start = Date.now();

  let bundle = globalCache.get(key);
  let cacheHit = true;

  if (!bundle) {
    cacheHit = false;
    bundle = compile(context);
    globalCache.set(key, bundle);
  }

  return {
    bundle,
    cacheHit,
    compileTimeMs: cacheHit ? 0 : Date.now() - start,
  };
}

export function getCacheStats() {
  return globalCache.getStats();
}
