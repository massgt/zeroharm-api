import { Router } from "express";

import multer from "multer";

import path from "node:path";

import { randomUUID } from "node:crypto";

import { desc, eq } from "drizzle-orm";

import { db } from "../db/index.js";
import {
	safetyCampaignsTable,
	safetyCampaignImagesTable,
	insertSafetyCampaignSchema,
} from "../db/schema/index.js";

const router = Router();

const campaignUploadStorage = multer.diskStorage({
	destination: (_req, _file, cb) => {
		cb(null, path.resolve("uploads/safety-campaigns"));
	},

	filename: (_req, file, cb) => {
		const extension = path.extname(file.originalname).toLowerCase();

		cb(null, `${randomUUID()}${extension}`);
	},
});

const campaignUpload = multer({
	storage: campaignUploadStorage,

	limits: {
		fileSize: 10 * 1024 * 1024,
		files: 10,
	},

	fileFilter: (_req, file, cb) => {
		const allowedMimeTypes = ["image/png", "image/jpeg", "image/webp"];

		const allowedExtensions = [".png", ".jpg", ".jpeg", ".webp"];

		const extension = path.extname(file.originalname).toLowerCase();

		if (
			allowedMimeTypes.includes(file.mimetype) &&
			allowedExtensions.includes(extension)
		) {
			cb(null, true);
			return;
		}

		cb(new Error("File harus berupa PNG, JPG, JPEG, atau WEBP."));
	},
});

/**
 * GET /api/safety-campaigns
 * Ambil semua safety campaign, terbaru di atas.
 */
router.get("/", async (_req, res): Promise<void> => {
	try {
		const campaigns = await db
			.select()
			.from(safetyCampaignsTable)
			.orderBy(
				desc(safetyCampaignsTable.year),
				desc(safetyCampaignsTable.week),
				desc(safetyCampaignsTable.id),
			);

		const campaignIds = campaigns.map((campaign) => campaign.id);

		if (campaignIds.length === 0) {
			res.json({
				success: true,
				data: [],
			});
			return;
		}

		const images = await db
			.select()
			.from(safetyCampaignImagesTable)
			.orderBy(safetyCampaignImagesTable.sortOrder);

		const imagesByCampaign = new Map<number, typeof images>();

		for (const image of images) {
			const existing = imagesByCampaign.get(image.campaignId) ?? [];
			existing.push(image);
			imagesByCampaign.set(image.campaignId, existing);
		}

		const data = campaigns.map((campaign) => ({
			...campaign,
			images: imagesByCampaign.get(campaign.id) ?? [],
		}));

		res.json({
			success: true,
			data,
		});
	} catch (error) {
		console.error("Failed to get safety campaigns:", error);

		res.status(500).json({
			success: false,
			error: "Failed to get safety campaigns",
		});
	}
});

/**
 * GET /api/safety-campaigns/:id
 * Ambil satu campaign berdasarkan ID.
 */
/**
 * POST /api/safety-campaigns/:id/images
 * Upload multiple poster untuk satu safety campaign.
 */
router.post(
	"/:id/images",
	campaignUpload.array("images", 10),
	async (req, res): Promise<void> => {
		try {
			const campaignId = Number(req.params.id);

			if (!Number.isInteger(campaignId) || campaignId <= 0) {
				res.status(400).json({
					success: false,
					error: "Invalid campaign ID",
				});
				return;
			}

			const [campaign] = await db
				.select()
				.from(safetyCampaignsTable)
				.where(eq(safetyCampaignsTable.id, campaignId))
				.limit(1);

			if (!campaign) {
				res.status(404).json({
					success: false,
					error: "Safety campaign not found",
				});
				return;
			}

			const files = (req.files ?? []) as Express.Multer.File[];

			if (files.length === 0) {
				res.status(400).json({
					success: false,
					error: "Tidak ada file gambar yang diupload.",
				});
				return;
			}

			const existingImages = await db
				.select()
				.from(safetyCampaignImagesTable)
				.where(eq(safetyCampaignImagesTable.campaignId, campaignId));

			const startSortOrder = existingImages.length;

			const insertedImages = await db
				.insert(safetyCampaignImagesTable)
				.values(
					files.map((file, index) => ({
						campaignId,
						filename: file.originalname,
						filePath: `/uploads/safety-campaigns/${file.filename}`,
						sortOrder: startSortOrder + index,
					})),
				)
				.returning();

			res.status(201).json({
				success: true,
				data: insertedImages,
			});
		} catch (error) {
			console.error("Failed to upload safety campaign images:", error);

			res.status(500).json({
				success: false,
				error: "Failed to upload safety campaign images",
			});
		}
	},
);

router.get("/:id", async (req, res): Promise<void> => {
	try {
		const campaignId = Number(req.params.id);

		if (!Number.isInteger(campaignId) || campaignId <= 0) {
			res.status(400).json({
				success: false,
				error: "Invalid campaign ID",
			});
			return;
		}

		const [campaign] = await db
			.select()
			.from(safetyCampaignsTable)
			.where(eq(safetyCampaignsTable.id, campaignId))
			.limit(1);

		if (!campaign) {
			res.status(404).json({
				success: false,
				error: "Safety campaign not found",
			});
			return;
		}

		const images = await db
			.select()
			.from(safetyCampaignImagesTable)
			.where(eq(safetyCampaignImagesTable.campaignId, campaignId))
			.orderBy(safetyCampaignImagesTable.sortOrder);

		res.json({
			success: true,
			data: {
				...campaign,
				images,
			},
		});
	} catch (error) {
		console.error("Failed to get safety campaign:", error);

		res.status(500).json({
			success: false,
			error: "Failed to get safety campaign",
		});
	}
});

/**
 * POST /api/safety-campaigns
 * Membuat safety campaign baru.
 */
router.post("/", async (req, res): Promise<void> => {
	try {
		const parsed = insertSafetyCampaignSchema.safeParse(req.body);

		if (!parsed.success) {
			res.status(400).json({
				success: false,
				error: "Invalid safety campaign data",
				details: parsed.error.flatten(),
			});
			return;
		}

		const [campaign] = await db
			.insert(safetyCampaignsTable)
			.values(parsed.data)
			.returning();

		res.status(201).json({
			success: true,
			data: campaign,
		});
	} catch (error) {
		console.error("Failed to create safety campaign:", error);

		res.status(500).json({
			success: false,
			error: "Failed to create safety campaign",
		});
	}
});

/**
 * PATCH /api/safety-campaigns/:id
 * Update safety campaign.
 */
router.patch("/:id", async (req, res): Promise<void> => {
	try {
		const id = Number(req.params.id);

		if (!Number.isInteger(id) || id <= 0) {
			res.status(400).json({
				success: false,
				error: "Invalid campaign ID",
			});
			return;
		}

		const parsed = insertSafetyCampaignSchema.partial().safeParse(req.body);

		if (!parsed.success) {
			res.status(400).json({
				success: false,
				error: "Invalid safety campaign data",
				details: parsed.error.flatten(),
			});
			return;
		}

		const [campaign] = await db
			.update(safetyCampaignsTable)
			.set({
				...parsed.data,
				updatedAt: new Date(),
			})
			.where(eq(safetyCampaignsTable.id, id))
			.returning();

		if (!campaign) {
			res.status(404).json({
				success: false,
				error: "Safety campaign not found",
			});
			return;
		}

		res.json({
			success: true,
			data: campaign,
		});
	} catch (error) {
		console.error("Failed to update safety campaign:", error);

		res.status(500).json({
			success: false,
			error: "Failed to update safety campaign",
		});
	}
});

/**
 * DELETE /api/safety-campaigns/:id
 * Hapus campaign.
 * Poster terkait otomatis ikut terhapus karena ON DELETE CASCADE.
 */
router.delete(
	"/:campaignId/images/:imageId",
	async (req, res): Promise<void> => {
		try {
			const campaignId = Number(req.params.campaignId);
			const imageId = Number(req.params.imageId);

			if (
				!Number.isInteger(campaignId) ||
				campaignId <= 0 ||
				!Number.isInteger(imageId) ||
				imageId <= 0
			) {
				res.status(400).json({
					success: false,
					error: "Invalid campaign or image ID",
				});
				return;
			}

			const [image] = await db
				.select()
				.from(safetyCampaignImagesTable)
				.where(eq(safetyCampaignImagesTable.id, imageId))
				.limit(1);

			if (!image || image.campaignId !== campaignId) {
				res.status(404).json({
					success: false,
					error: "Campaign image not found",
				});
				return;
			}

			await db
				.delete(safetyCampaignImagesTable)
				.where(eq(safetyCampaignImagesTable.id, imageId));

			// Hapus file fisik
			const fs = await import("node:fs/promises");

			const relativePath = image.filePath.replace(/^\/uploads\//, "");
			const physicalPath = path.resolve("uploads", relativePath);

			try {
				await fs.unlink(physicalPath);
			} catch (fileError: any) {
				if (fileError?.code !== "ENOENT") {
					console.error("Failed to delete campaign image file:", fileError);
				}
			}

			res.json({
				success: true,
				message: "Campaign image deleted successfully",
			});
		} catch (error) {
			console.error("DELETE SAFETY CAMPAIGN IMAGE ERROR:", error);

			res.status(500).json({
				success: false,
				error: "Failed to delete safety campaign image",
			});
		}
	},
);

router.delete("/:id", async (req, res): Promise<void> => {
	try {
		const campaignId = Number(req.params.id);

		if (!Number.isInteger(campaignId) || campaignId <= 0) {
			res.status(400).json({
				success: false,
				error: "Invalid campaign ID",
			});
			return;
		}

		// 1. Pastikan campaign ada
		const [campaign] = await db
			.select()
			.from(safetyCampaignsTable)
			.where(eq(safetyCampaignsTable.id, campaignId))
			.limit(1);

		if (!campaign) {
			res.status(404).json({
				success: false,
				error: "Safety campaign not found",
			});
			return;
		}

		// 2. Ambil seluruh poster campaign
		const images = await db
			.select()
			.from(safetyCampaignImagesTable)
			.where(eq(safetyCampaignImagesTable.campaignId, campaignId));

		// 3. Hapus file fisik poster
		const fs = await import("node:fs/promises");

		for (const image of images) {
			const relativePath = image.filePath.replace(/^\/uploads\//, "");

			const physicalPath = path.resolve("uploads", relativePath);

			try {
				await fs.unlink(physicalPath);
			} catch (fileError: any) {
				if (fileError?.code !== "ENOENT") {
					console.error("Failed to delete campaign image file:", fileError);
				}
			}
		}

		// 4. Hapus campaign
		// Image records ikut terhapus karena
		// ON DELETE CASCADE pada foreign key.
		await db
			.delete(safetyCampaignsTable)
			.where(eq(safetyCampaignsTable.id, campaignId));

		res.json({
			success: true,
			message: "Safety campaign deleted successfully",
		});
	} catch (error) {
		console.error("DELETE SAFETY CAMPAIGN ERROR:", error);

		res.status(500).json({
			success: false,
			error: "Failed to delete safety campaign",
		});
	}
});

export default router;
