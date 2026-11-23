import {
	pgTable,
	serial,
	integer,
	timestamp,
	unique,
	index,
} from "drizzle-orm/pg-core";
import { attendanceRecordsTable } from "./attendance-records.js";
import { excelUploadsTable } from "./excel-uploads.js";

export const attendanceUploadLinksTable = pgTable(
	"attendance_upload_links",
	{
		id: serial("id").primaryKey(),
		attendanceId: integer("attendance_id")
			.notNull()
			.references(() => attendanceRecordsTable.id, { onDelete: "cascade" }),
		uploadId: integer("upload_id")
			.notNull()
			.references(() => excelUploadsTable.id, { onDelete: "cascade" }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(t) => [
		unique("uniq_attendance_upload_link").on(t.attendanceId, t.uploadId),
		index("idx_attendance_upload_links_upload_id").on(t.uploadId),
	],
);
