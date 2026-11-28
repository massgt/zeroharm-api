-- Support server-side aggregation for the SAP dashboard.
-- Keeps the week filter and active-upload grouping covered by one index.
CREATE INDEX IF NOT EXISTS idx_report_entries_week_upload
  ON public.report_entries (week, upload_id)
  INCLUDE (year, month, nik, type, sub_type, time_compliance);
