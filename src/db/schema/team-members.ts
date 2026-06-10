import { pgTable, text, integer, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const teamMembersTable = pgTable("team_members", {
  nik: text("nik").primaryKey(),
  name: text("name").notNull(),
  department: text("department").notNull(),
  jabatan: text("jabatan").notNull(),
  isPjo: boolean("is_pjo").notNull().default(false),
  isOnLeave: boolean("is_on_leave").notNull().default(false),
  targetHazard: integer("target_hazard").notNull().default(7),
  targetInspeksi: integer("target_inspeksi").notNull().default(7),
  targetObservasi: integer("target_observasi").notNull().default(4),
  targetOpk: integer("target_opk").notNull().default(10),
});

export const insertTeamMemberSchema = createInsertSchema(teamMembersTable);
export type InsertTeamMember = z.infer<typeof insertTeamMemberSchema>;
export type TeamMember = typeof teamMembersTable.$inferSelect;
