CREATE TABLE IF NOT EXISTS "blog_generation_analytics" (
  "id"                          serial PRIMARY KEY,
  "created_at"                  timestamptz NOT NULL DEFAULT now(),
  "project_id"                  integer,
  "article_title"               text,
  "pipeline_version"            text NOT NULL DEFAULT '14',
  "generation_time_ms"          integer NOT NULL DEFAULT 0,
  "target_word_count"           integer NOT NULL DEFAULT 0,
  "actual_word_count"           integer NOT NULL DEFAULT 0,
  "quality_score"               integer,
  "seo_score"                   integer,
  "readability_score"           integer,
  "structure_score"             integer,
  "formatting_score"            integer,
  "content_score"               integer,
  "retry_count"                 integer NOT NULL DEFAULT 0,
  "component_regenerations"     integer NOT NULL DEFAULT 0,
  "recovered_parallel_tasks"    integer NOT NULL DEFAULT 0,
  "unrecovered_parallel_tasks"  integer NOT NULL DEFAULT 0,
  "semantic_warning_count"      integer NOT NULL DEFAULT 0,
  "semantic_error_count"        integer NOT NULL DEFAULT 0,
  "ai_call_count"               integer NOT NULL DEFAULT 0,
  "total_prompt_chars"          integer NOT NULL DEFAULT 0,
  "total_completion_chars"      integer NOT NULL DEFAULT 0,
  "outline_time_ms"             integer NOT NULL DEFAULT 0,
  "parallel_time_ms"            integer NOT NULL DEFAULT 0,
  "parallel_recovery_time_ms"   integer NOT NULL DEFAULT 0,
  "faq_time_ms"                 integer NOT NULL DEFAULT 0,
  "regeneration_time_ms"        integer NOT NULL DEFAULT 0,
  "top_failure_reasons"         text,
  "warnings"                    text,
  "extra_metrics"               jsonb DEFAULT '{}'::jsonb
);

-- Analytics table is server-write only (service role key).
-- RLS enabled but no public policies — anon/authenticated have no access.
ALTER TABLE "blog_generation_analytics" ENABLE ROW LEVEL SECURITY;
