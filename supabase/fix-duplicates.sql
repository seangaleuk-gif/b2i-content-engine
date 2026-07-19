-- Clean up existing duplicate prompt sections (keep the most recently updated row per key)
DELETE FROM prompt_sections a
USING prompt_sections b
WHERE a.user_id = b.user_id
  AND a.section_key = b.section_key
  AND a.id < b.id;

-- Prevent future duplicates
ALTER TABLE prompt_sections ADD CONSTRAINT uq_prompt_sections_user_key UNIQUE (user_id, section_key);
