import {
	pgTable,
	serial,
	text,
	timestamp,
	integer,
	jsonb,
} from "drizzle-orm/pg-core";

import { createInsertSchema } from "drizzle-zod";

import { z } from "zod/v4";

export const excelUploadsTable = pgTable("excel_uploads", {
	id: serial("id").primaryKey(),

	filename: text("filename").notNull(),

	uploadedAt: timestamp("uploaded_at", {
		withTimezone: true,
	})
		.notNull()
		.defaultNow(),

	weeksFound: jsonb("weeks_found")
		.notNull()
		.$type<string[]>()
		.default([]),

	rowsProcessed: integer("rows_processed").notNull().default(0),

	sourceType: text("source_type").notNull().default("manual"),

	sourceUrl: text("source_url"),

	sourceId: text("source_id"),

	lastSyncedAt: timestamp("last_synced_at", {
		withTimezone: true,
	}),
});

export const insertExcelUploadSchema = createInsertSchema(
	excelUploadsTable,
).omit({
	id: true,
	uploadedAt: true,
});

export type InsertExcelUpload = z.infer<typeof insertExcelUploadSchema>;

export type ExcelUpload = typeof excelUploadsTable.$inferSelect;
