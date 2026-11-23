-- Attendance many-to-many upload relationship.
-- Run once on the target database before deploying the API code that uses the new links.
BEGIN;

ALTER TABLE attendance_records
	ALTER COLUMN upload_id DROP NOT NULL;

DO $$
DECLARE
	fk_name text;
BEGIN
	SELECT conname
	INTO fk_name
	FROM pg_constraint
	WHERE conrelid = 'attendance_records'::regclass
	  AND confrelid = 'excel_uploads'::regclass
	  AND contype = 'f';

	IF fk_name IS NOT NULL THEN
		EXECUTE format('ALTER TABLE attendance_records DROP CONSTRAINT %I', fk_name);
	END IF;
END $$;

CREATE TABLE attendance_upload_links (
	id serial PRIMARY KEY,
	attendance_id integer NOT NULL REFERENCES attendance_records(id) ON DELETE CASCADE,
	upload_id integer NOT NULL REFERENCES excel_uploads(id) ON DELETE CASCADE,
	created_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT uniq_attendance_upload_link UNIQUE (attendance_id, upload_id)
);

CREATE INDEX idx_attendance_upload_links_upload_id
	ON attendance_upload_links(upload_id);

-- Backfill the existing one-to-one ownership into the new relationship table.
INSERT INTO attendance_upload_links (attendance_id, upload_id)
SELECT id, upload_id
FROM attendance_records
WHERE upload_id IS NOT NULL
ON CONFLICT (attendance_id, upload_id) DO NOTHING;

COMMIT;
