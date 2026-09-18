import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";
import { safetyCampaignsTable } from "./safety-campaigns";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const safetyCampaignImagesTable = pgTable("safety_campaign_images", {
	id: serial("id").primaryKey(),

	campaignId: integer("campaign_id")
		.notNull()
		.references(() => safetyCampaignsTable.id, {
			onDelete: "cascade",
		}),

	filename: text("filename").notNull(),

	filePath: text("file_path").notNull(),

	sortOrder: integer("sort_order").notNull().default(0),

	createdAt: timestamp("created_at", {
		withTimezone: true,
	})
		.notNull()
		.defaultNow(),
});

export const insertSafetyCampaignImageSchema = createInsertSchema(
	safetyCampaignImagesTable,
).omit({
	id: true,
	createdAt: true,
});

export type InsertSafetyCampaignImage = z.infer<
	typeof insertSafetyCampaignImageSchema
>;

export type SafetyCampaignImage = typeof safetyCampaignImagesTable.$inferSelect;
