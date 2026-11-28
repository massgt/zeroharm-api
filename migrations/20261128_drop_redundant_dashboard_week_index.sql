-- The existing idx_report_entries_week_upload index already covers
-- dashboard week filtering and includes year/month plus aggregation columns.
-- Keep the existing covering index; remove the redundant composite index.
DROP INDEX IF EXISTS public.idx_report_entries_week_period_upload;
