import {
	pgTable,
	serial,
	text,
	integer,
	date,
	boolean,
	timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const safetyCampaignsTable = pgTable("safety_campaigns", {
	id: serial("id").primaryKey(),

	week: integer("week").notNull(),

	year: integer("year").notNull(),

	title: text("title").notNull(),

	highlight: text("highlight"),

	startDate: date("start_date"),

	endDate: date("end_date"),

	isActive: boolean("is_active").notNull().default(true),

	createdAt: timestamp("created_at", {
		withTimezone: true,
	})
		.notNull()
		.defaultNow(),

	updatedAt: timestamp("updated_at", {
		withTimezone: true,
	})
		.notNull()
		.defaultNow(),
});

export const insertSafetyCampaignSchema = createInsertSchema(
	safetyCampaignsTable,
).omit({
	id: true,
	createdAt: true,
	updatedAt: true,
});

export type InsertSafetyCampaign = z.infer<typeof insertSafetyCampaignSchema>;

export type SafetyCampaign = typeof safetyCampaignsTable.$inferSelect;
