-- Supports week-scoped dashboard aggregation and active-upload selection.
CREATE INDEX IF NOT EXISTS idx_report_entries_week_period_upload
  ON public.report_entries (week, year, month, upload_id);
