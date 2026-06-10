import { pgTable, text, serial, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const safetyReportsTable = pgTable("safety_reports", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description"),
  type: text("type").notNull(),
  severity: text("severity").notNull(),
  status: text("status").notNull().default("open"),
  department: text("department").notNull(),
  location: text("location").notNull(),
  reportedBy: text("reported_by").notNull(),
  reportedAt: timestamp("reported_at", { withTimezone: true }).notNull().defaultNow(),
  correctiveAction: text("corrective_action"),
  closedAt: timestamp("closed_at", { withTimezone: true }),
});

export const insertSafetyReportSchema = createInsertSchema(safetyReportsTable).omit({
  id: true,
  reportedAt: true,
});
export type InsertSafetyReport = z.infer<typeof insertSafetyReportSchema>;
export type SafetyReport = typeof safetyReportsTable.$inferSelect;
