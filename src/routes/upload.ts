import { Router, type IRouter } from "express";
import multer from "multer";
import * as xlsx from "xlsx";
import { db, excelUploadsTable, reportEntriesTable } from "../db";
import { ListUploadsResponse } from "../api-zod";
import { eq } from "drizzle-orm";

const router: IRouter = Router();
const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } });

const COMPANY = "PT. Minergo Visi Maxima";

function excelDateToYear(val: unknown): number {
	if (typeof val === "number") {
		const d = xlsx.SSF.parse_date_code(val);
		return d?.y ?? new Date().getFullYear();
	}
	if (typeof val === "string") {
		return new Date(val).getFullYear() || new Date().getFullYear();
	}
	return new Date().getFullYear();
}

type OPKSubType =
	| "keberadaan_pengawas"
	| "fungsi_pengawas"
	| "pencahayaan"
	| "p2h"
	| "seatbelt"
	| "simper"
	| "roster"
	| "fatigue"
	| "lototo";

interface ParsedEntry {
	sourceId: string;
	type: "tta" | "hazard" | "inspeksi" | "observasi" | "opk";
	subType?: OPKSubType;
	timeCompliance?: string;
	nik: string;
	week: string;
	month: number;
	year: number;
}

// OPK sub-type mapping: normalized column value → subType key
// TODO: Update these mappings once OPK column indices are confirmed from the actual Excel file.
// Currently mapping based on expected "Jenis OPK" column values.

function normalizeOPKSubType(value: unknown): OPKSubType | undefined {
	const str = String(value ?? "")
		.trim()
		.toLowerCase();

	if (str.includes("sidak p2h")) return "p2h";

	if (str.includes("seatbelt")) return "seatbelt";

	if (str.includes("simper")) return "simper";

	if (str.includes("roster")) return "roster";

	if (str.includes("fatigue")) return "fatigue";

	if (str.includes("lototo")) return "lototo";

	if (str.includes("keberadaan pengawas")) return "keberadaan_pengawas";

	if (str.includes("fungsi pengawas")) return "fungsi_pengawas";

	if (str.includes("sidak pencahayaan")) return "pencahayaan";

	return undefined;
}

function parseExcel(buffer: Buffer): {
	entries: ParsedEntry[];
	rowsProcessed: number;
} {
	const wb = xlsx.read(buffer, {
		type: "buffer",
		cellStyles: false,
		cellHTML: false,
		cellFormula: false,
		cellNF: false,
		cellDates: false,
	});
	const entries: ParsedEntry[] = [];
	let rowsProcessed = 0;

	// --- HAZARD ---
	// Columns: [0]ID, [2]NIK, [6]Perusahaan, [22]Tanggal, [31]Week, [32]Month
	const hazardWs = wb.Sheets["Hazard"];

	if (hazardWs) {
		const rows = xlsx.utils.sheet_to_json<unknown[]>(hazardWs, {
			header: 1,
			defval: "",
		});

		for (let i = 1; i < rows.length; i++) {
			const r = rows[i] as unknown[];

			if (String(r[6] ?? "").trim() !== COMPANY) continue;

			const nik = String(r[2] ?? "").trim();
			if (!nik) continue;

			const week = String(r[31] ?? "").trim();
			const month = Number(r[32]) || 0;
			const year = excelDateToYear(r[22]);

			const sourceId = String(r[0] ?? "").trim();

			if (!sourceId || !week) continue;

			entries.push({
				sourceId: `haz_${sourceId}`,
				type: "hazard",
				nik,
				week,
				month,
				year,
			});

			const jenisTemuan = String(r[15] ?? "")
				.trim()
				.toUpperCase();

			if (jenisTemuan === "TTA") {
				entries.push({
					sourceId: `tta_${sourceId}`,
					type: "tta",
					nik,
					week,
					month,
					year,
				});
			}

			rowsProcessed++;
		}
	}

	// --- INSPEKSI ---
	// Columns: [2]NIK, [4]Perusahaan, [6]ID, [16]Tanggal, [22]Week, [23]Month
	// Columns:
	// [2] NIK
	// [4] Perusahaan
	// [6] ID
	// [16] Tanggal
	// [22] Week
	// [23] Month
	// [25] Status Kesesuaian Waktu (kolom Z)
	const inspWs = wb.Sheets["Inspeksi"];
	if (inspWs) {
		const rows = xlsx.utils.sheet_to_json<unknown[]>(inspWs, {
			header: 1,
			defval: "",
		});
		for (let i = 1; i < rows.length; i++) {
			const r = rows[i] as unknown[];
			if (String(r[4] ?? "").trim() !== COMPANY) continue;
			const nik = String(r[2] ?? "").trim();
			if (!nik) continue;
			const week = String(r[22] ?? "").trim();
			const month = Number(r[23]) || 0;
			const year = excelDateToYear(r[16]);
			const sourceId = String(r[6] ?? "").trim();

			if (!sourceId || !week) continue;

			entries.push({
				sourceId: `ins_${sourceId}`,
				type: "inspeksi",
				nik,
				week,
				month,
				year,
				timeCompliance: timeCompliance || undefined,
			});
			rowsProcessed++;
		}
	}

	// --- OBSERVASI ---
	// Columns: [0]ID, [5]Tanggal, [18]NIK, [22]Perusahaan, [23]Week, [24]Month
	const obsWs = wb.Sheets["Observasi"];
	if (obsWs) {
		const rows = xlsx.utils.sheet_to_json<unknown[]>(obsWs, {
			header: 1,
			defval: "",
		});
		for (let i = 1; i < rows.length; i++) {
			const r = rows[i] as unknown[];
			if (String(r[22] ?? "").trim() !== COMPANY) continue;
			const nik = String(r[18] ?? "").trim();
			if (!nik) continue;
			const week = String(r[23] ?? "").trim();
			const month = Number(r[24]) || 0;
			const year = excelDateToYear(r[5]);
			const sourceId = String(r[0] ?? "").trim();
			if (!sourceId || !week) continue;
			entries.push({
				sourceId: `obs_${sourceId}`,
				type: "observasi",
				nik,
				week,
				month,
				year,
			});
			rowsProcessed++;
		}
	}

	// --- OPK ---
	const opkWs = wb.Sheets["OPK"];

	if (opkWs) {
		const rows = xlsx.utils.sheet_to_json<unknown[]>(opkWs, {
			header: 1,
			defval: "",
		});

		for (let i = 1; i < rows.length; i++) {
			const r = rows[i] as unknown[];

			// D = Company
			if (String(r[3] ?? "").trim() !== COMPANY) continue;

			// C = NIK
			const nik = String(r[2] ?? "").trim();

			if (!nik) continue;

			// S = Week
			const week = String(r[18] ?? "").trim();

			if (!week) continue;

			// T = Month
			const month = Number(r[19]) || 0;

			// Q = Date
			const year = excelDateToYear(r[16]);

			// A = ID
			const sourceId = String(r[0] ?? "").trim();

			if (!sourceId) continue;

			// P = Jenis Pekerjaan
			const jenisPekerjaan = String(r[15] ?? "").trim();

			// if (nik === "C-047522" && week === "W25") {
			// 	console.log(sourceId, "=>", jenisPekerjaan);
			// }

			// R = Status
			const status = Number(r[17]) || 0;

			// Hanya status=1 seperti Excel BIB
			if (status !== 1) continue;

			const subType = normalizeOPKSubType(jenisPekerjaan);

			if (!subType) continue;

			entries.push({
				sourceId: `opk_${sourceId}`,
				type: "opk",
				subType,
				nik,
				week,
				month,
				year,
			});

			rowsProcessed++;
		}
	}

	return { entries, rowsProcessed };
}

router.post(
	"/upload",
	upload.single("file"),
	async (req, res): Promise<void> => {
		try {
			if (!req.file) {
				res
					.status(400)
					.json({ error: "No file uploaded. Use form field name: file" });
				return;
			}

			req.log.info(
				{ filename: req.file.originalname, size: req.file.size },
				"Processing Excel upload",
			);

			const { entries, rowsProcessed } = parseExcel(req.file.buffer);

			const uniqueEntries = new Map<string, ParsedEntry>();
			for (const e of entries) {
				uniqueEntries.set(`${e.sourceId}|${e.type}|${e.subType ?? ""}`, e);
			}
			const deduped = Array.from(uniqueEntries.values());

			const weeksFound = Array.from(new Set(deduped.map((e) => e.week))).sort();

			// Remove old records for weeks contained in uploaded file
			for (const week of weeksFound) {
				await db
					.delete(reportEntriesTable)
					.where(eq(reportEntriesTable.week, week));
			}

			const [uploadRecord] = await db
				.insert(excelUploadsTable)
				.values({ filename: req.file.originalname, weeksFound, rowsProcessed })
				.returning();

			const BATCH = 500;
			const toInsert = deduped.map((e) => ({
				uploadId: uploadRecord.id,
				sourceId: e.sourceId,
				type: e.type,
				subType: e.subType ?? null,
				nik: e.nik,
				week: e.week,
				month: e.month,
				year: e.year,
				timeCompliance: e.timeCompliance ?? null,
			}));

			for (let i = 0; i < toInsert.length; i += BATCH) {
				await db
					.insert(reportEntriesTable)
					.values(toInsert.slice(i, i + BATCH))
					.onConflictDoNothing();
			}

			req.log.info(
				{
					uploadId: uploadRecord.id,
					minergoRows: deduped.length,
					weeks: weeksFound,
				},
				"Upload processed",
			);

			res.json({
				uploadId: uploadRecord.id,
				weeksFound,
				rowsProcessed,
				minergoRows: deduped.length,
			});
		} catch (err) {
			console.error("UPLOAD ERROR");
			console.error(err);

			res.status(500).json({
				error: String(err),
			});
		}
	},
);

router.get("/uploads", async (_req, res): Promise<void> => {
	const uploads = await db
		.select()
		.from(excelUploadsTable)
		.orderBy(excelUploadsTable.uploadedAt);
	res.json(
		ListUploadsResponse.parse(
			uploads.map((u) => ({
				...u,
				uploadedAt: u.uploadedAt.toISOString(),
				weeksFound: u.weeksFound as string[],
			})),
		),
	);
});

export default router;
