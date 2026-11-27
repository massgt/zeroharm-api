-- Align the testing database with the current Drizzle schema.
-- Safe to run more than once; adds only columns missing from older databases.
BEGIN;

ALTER TABLE public.excel_uploads
  ADD COLUMN IF NOT EXISTS source_type text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS source_url text,
  ADD COLUMN IF NOT EXISTS source_id text,
  ADD COLUMN IF NOT EXISTS last_synced_at timestamptz;

ALTER TABLE public.report_entries
  ADD COLUMN IF NOT EXISTS time_compliance text;

COMMIT;
