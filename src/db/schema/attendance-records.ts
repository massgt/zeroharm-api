import {
	pgTable,
	serial,
	text,
	integer,
	date,
	timestamp,
	unique,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { excelUploadsTable } from "./excel-uploads.js";

export const attendanceRecordsTable = pgTable(
	"attendance_records",
	{
		id: serial("id").primaryKey(),

		uploadId: integer("upload_id")
			.notNull()
			.references(() => excelUploadsTable.id, {
				onDelete: "cascade",
			}),

		nik: text("nik").notNull(),
		eventDate: date("event_date", { mode: "string" }).notNull(),
		eventType: text("event_type").notNull(),

		week: text("week").notNull(),
		month: integer("month").notNull(),
		year: integer("year").notNull(),

		sourceFile: text("source_file").notNull(),

		createdAt: timestamp("created_at", {
			withTimezone: true,
		})
			.defaultNow()
			.notNull(),
	},
	(t) => [
		unique("uniq_attendance_record").on(
			t.nik,
			t.eventDate,
			t.eventType,
			t.week,
			t.month,
			t.year,
		),
	],
);

export const insertAttendanceRecordSchema = createInsertSchema(
	attendanceRecordsTable,
).omit({ id: true, createdAt: true });

export type InsertAttendanceRecord = z.infer<
	typeof insertAttendanceRecordSchema
>;

export type AttendanceRecord = typeof attendanceRecordsTable.$inferSelect;
