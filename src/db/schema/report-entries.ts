import { pgTable, serial, text, integer, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const reportEntriesTable = pgTable("report_entries", {
  id: serial("id").primaryKey(),
  uploadId: integer("upload_id").notNull(),
  sourceId: text("source_id").notNull(),
  type: text("type").notNull(), // 'hazard' | 'inspeksi' | 'observasi' | 'opk'
  nik: text("nik").notNull(),
  week: text("week").notNull(), // e.g. 'W23'
  month: integer("month").notNull(),
  year: integer("year").notNull(),
}, (t) => [
  unique("uniq_report_entry").on(t.sourceId, t.type),
]);

export const insertReportEntrySchema = createInsertSchema(reportEntriesTable).omit({ id: true });
export type InsertReportEntry = z.infer<typeof insertReportEntrySchema>;
export type ReportEntry = typeof reportEntriesTable.$inferSelect;
