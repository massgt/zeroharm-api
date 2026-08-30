import { pgTable, text, integer, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const teamMembersTable = pgTable("team_members", {
	nik: text("nik").primaryKey(),
	name: text("name").notNull(),
	department: text("department").notNull(),
	jabatan: text("jabatan").notNull(),
	isPjo: boolean("is_pjo").notNull().default(false),
	isHse: boolean("is_hse").notNull().default(false),
	isOnLeave: boolean("is_on_leave").notNull().default(false),

	// Shared categories
	targetTta: integer("target_tta").notNull().default(0),
	targetHazard: integer("target_hazard").notNull().default(7),
	targetInspeksi: integer("target_inspeksi").notNull().default(7),
	targetObservasi: integer("target_observasi").notNull().default(4),

	// OPK for HSE
	targetOpkKeberadaanPengawas: integer("target_opk_keberadaan_pengawas")
		.notNull()
		.default(0),
	targetOpkFungsiPengawas: integer("target_opk_fungsi_pengawas")
		.notNull()
		.default(0),
	targetOpkPencahayaan: integer("target_opk_pencahayaan").notNull().default(0),

	// OPK for Pengawas/Team Leader
	targetOpkP2h: integer("target_opk_p2h").notNull().default(0),
	targetOpkSeatbelt: integer("target_opk_seatbelt").notNull().default(0),
	targetOpkSimper: integer("target_opk_simper").notNull().default(0),
	targetOpkRoster: integer("target_opk_roster").notNull().default(0),
	targetOpkFatigue: integer("target_opk_fatigue").notNull().default(0),
	targetOpkLototo: integer("target_opk_lototo").notNull().default(0),
});

export const insertTeamMemberSchema = createInsertSchema(teamMembersTable);
export type InsertTeamMember = z.infer<typeof insertTeamMemberSchema>;
export type TeamMember = typeof teamMembersTable.$inferSelect;
