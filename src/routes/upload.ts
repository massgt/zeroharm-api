import { Router, type IRouter } from "express";

import multer from "multer";

import * as xlsx from "xlsx";

import { db, excelUploadsTable, reportEntriesTable } from "../db/index.js";

import { ListUploadsResponse } from "../api-zod/index.js";

import { eq, sql } from "drizzle-orm";

import { getGoogleSheetValues } from "../services/google-sheets.js";

import {
	getGoogleDriveFile,
	downloadGoogleDriveFile,
	testGoogleDriveFile,
} from "../services/google-drive.js";

import {
	parseGoogleDriveXlsx,
	type ParsedGoogleEntry,
} from "../services/google-sheet-stream.js";

const router: IRouter = Router();
const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } });

const COMPANY = "PT. Minergo Visi Maxima";

const GOOGLE_SHEET_SOURCES = [
	{
		name: "Hazard",
		companyColumn: "G",
	},
	{
		name: "Inspeksi",
		companyColumn: "E",
	},
	{
		name: "Observasi",
		companyColumn: "W",
	},
	{
		name: "OPK",
		companyColumn: "D",
	},
] as const;

function extractGoogleSpreadsheetId(url: string): string | null {
	try {
		const parsed = new URL(url);

		if (parsed.hostname !== "docs.google.com") {
			return null;
		}

		const match = parsed.pathname.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);

		return match?.[1] ?? null;
	} catch {
		return null;
	}
}

function buildGoogleSheetQueryUrl(
	spreadsheetId: string,
	sheetName: string,
	companyColumn: string,
): string {
	const query = `select * where ${companyColumn} = '${COMPANY.replace(/'/g, "''")}'`;

	const params = new URLSearchParams({
		sheet: sheetName,
		tqx: "out:csv",
		tq: query,
	});

	return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?${params.toString()}`;
}

async function downloadGoogleSheetTab(
	spreadsheetId: string,
	sheetName: string,
	companyColumn: string,
): Promise<Buffer> {
	const url = buildGoogleSheetQueryUrl(spreadsheetId, sheetName, companyColumn);

	const response = await fetch(url, {
		redirect: "follow",
		headers: {
			"User-Agent":
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/151 Safari/537.36",
			Accept: "text/csv,text/plain,*/*",
		},
	});

	if (!response.ok) {
		throw new Error(
			`Failed to download Google Sheet "${sheetName}": HTTP ${response.status}`,
		);
	}

	const text = await response.text();

	if (!text.trim()) {
		throw new Error(`Google Sheet "${sheetName}" returned empty data`);
	}

	return Buffer.from(text, "utf8");
}

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

function convertGoogleEntry(entry: ParsedGoogleEntry): ParsedEntry {
	return {
		sourceId: entry.sourceId,
		type: entry.type,
		subType: entry.subType,
		nik: entry.nik,
		week: entry.week,
		month: entry.month,
		year: entry.year,
		timeCompliance: entry.timeCompliance,
	};
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
			const timeCompliance = String(r[25] ?? "").trim();

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

async function parseGoogleSheet(spreadsheetId: string): Promise<{
	entries: ParsedEntry[];
	rowsProcessed: number;
	sheetsProcessed: string[];
}> {
	const entries: ParsedEntry[] = [];
	let rowsProcessed = 0;
	const sheetsProcessed: string[] = [];

	for (const source of GOOGLE_SHEET_SOURCES) {
		const csvBuffer = await downloadGoogleSheetTab(
			spreadsheetId,
			source.name,
			source.companyColumn,
		);

		const wb = xlsx.read(csvBuffer, {
			type: "buffer",
			cellStyles: false,
			cellHTML: false,
			cellFormula: false,
			cellNF: false,
			cellDates: false,
		});

		const ws = wb.Sheets[wb.SheetNames[0]];

		if (!ws) {
			throw new Error(`Google Sheet "${source.name}" returned no worksheet`);
		}

		const rows = xlsx.utils.sheet_to_json<unknown[]>(ws, {
			header: 1,
			defval: "",
		});

		if (rows.length <= 1) {
			sheetsProcessed.push(source.name);
			continue;
		}

		if (source.name === "Hazard") {
			for (let i = 1; i < rows.length; i++) {
				const r = rows[i] as unknown[];

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

		if (source.name === "Inspeksi") {
			for (let i = 1; i < rows.length; i++) {
				const r = rows[i] as unknown[];

				const nik = String(r[2] ?? "").trim();
				if (!nik) continue;

				const week = String(r[22] ?? "").trim();
				const month = Number(r[23]) || 0;
				const year = excelDateToYear(r[16]);
				const sourceId = String(r[6] ?? "").trim();
				const timeCompliance = String(r[25] ?? "").trim();

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

		if (source.name === "Observasi") {
			for (let i = 1; i < rows.length; i++) {
				const r = rows[i] as unknown[];

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

		if (source.name === "OPK") {
			for (let i = 1; i < rows.length; i++) {
				const r = rows[i] as unknown[];

				const nik = String(r[2] ?? "").trim();
				if (!nik) continue;

				const week = String(r[18] ?? "").trim();
				if (!week) continue;

				const month = Number(r[19]) || 0;
				const year = excelDateToYear(r[16]);
				const sourceId = String(r[0] ?? "").trim();

				if (!sourceId) continue;

				const jenisPekerjaan = String(r[15] ?? "").trim();
				const status = Number(r[17]) || 0;

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

		sheetsProcessed.push(source.name);
	}

	return {
		entries,
		rowsProcessed,
		sheetsProcessed,
	};
}

async function saveGoogleSheetData(
	spreadsheetId: string,
	sourceUrl: string,
): Promise<{
	uploadId: number;
	entries: number;
	rowsProcessed: number;
	weeksFound: string[];
}> {
	const entries: ParsedEntry[] = [];

	const result = await parseGoogleDriveXlsx(spreadsheetId, (entry) => {
		entries.push(convertGoogleEntry(entry));
	});

	const uniqueEntries = new Map<string, ParsedEntry>();

	for (const entry of entries) {
		uniqueEntries.set(
			`${entry.sourceId}|${entry.type}|${entry.subType ?? ""}`,
			entry,
		);
	}

	const deduped = Array.from(uniqueEntries.values());

	const weeksFound = Array.from(
		new Set(deduped.map((entry) => entry.week)),
	).sort();

	if (deduped.length === 0) {
		throw new Error(
			"No PT. Minergo Visi Maxima data found in the Google Spreadsheet",
		);
	}

	await reconcileBeforeUpload(deduped, weeksFound, {
		sourceType: "google_sheet",
		sourceId: spreadsheetId,
	});

	// Simpan metadata upload/sync baru
	const [uploadRecord] = await db
		.insert(excelUploadsTable)
		.values({
			filename: `Google Sheet ${spreadsheetId}`,
			weeksFound,
			rowsProcessed: result.rowsProcessed,
			sourceType: "google_sheet",
			sourceUrl,
			sourceId: spreadsheetId,
			lastSyncedAt: new Date(),
		})
		.returning();

	const BATCH = 500;

	const toInsert = deduped.map((entry) => ({
		uploadId: uploadRecord.id,
		sourceId: entry.sourceId,
		type: entry.type,
		subType: entry.subType ?? null,
		nik: entry.nik,
		week: entry.week,
		month: entry.month,
		year: entry.year,
		timeCompliance: entry.timeCompliance ?? null,
	}));

	for (let i = 0; i < toInsert.length; i += BATCH) {
		await db
			.insert(reportEntriesTable)
			.values(toInsert.slice(i, i + BATCH))
			.onConflictDoNothing();
	}

	return {
		uploadId: uploadRecord.id,
		entries: deduped.length,
		rowsProcessed: result.rowsProcessed,
		weeksFound,
	};
}

async function reconcileBeforeUpload(
	deduped: ParsedEntry[],
	weeksFound: string[],
	options: {
		sourceType: "manual" | "google_sheet";
		sourceId?: string;
	},
) {
	if (deduped.length === 0) {
		return;
	}

	/*
	 * ============================================================
	 * ACTIVE VERSION RULE
	 * ============================================================
	 *
	 * Periode ditentukan dari YEAR + MONTH.
	 *
	 * Contoh:
	 * 2026-08 = Agustus
	 * 2026-09 = September
	 *
	 * Jika upload baru mempunyai periode yang lebih baru:
	 * - data periode lama diganti
	 * - tetapi week lintas bulan tetap dipertahankan
	 *
	 * Jika upload baru mempunyai periode yang sama:
	 * - upload lama pada periode tersebut diganti
	 *
	 * Jika upload baru lebih lama:
	 * - upload yang lebih baru tidak disentuh
	 */

	const newPeriods = new Set(
		deduped.map((entry) => entry.year * 100 + entry.month),
	);

	const newLatestPeriod = Math.max(...newPeriods);

	const newWeeks = new Set(weeksFound);

	const previousUploads = await db
		.select({
			id: excelUploadsTable.id,
			sourceId: excelUploadsTable.sourceId,
			sourceType: excelUploadsTable.sourceType,
		})
		.from(excelUploadsTable);

	for (const previousUpload of previousUploads) {
		/*
		 * ==========================================================
		 * GOOGLE SHEET YANG SAMA
		 * ==========================================================
		 *
		 * Jika spreadsheet ID sama, berarti user melakukan
		 * synchronization / re-sync terhadap spreadsheet yang sama.
		 *
		 * Versi lama dari spreadsheet tersebut harus diganti.
		 *
		 * Upload record tetap disimpan untuk audit trail.
		 */
		if (
			options.sourceType === "google_sheet" &&
			previousUpload.sourceType === "google_sheet" &&
			previousUpload.sourceId === options.sourceId
		) {
			await db
				.delete(reportEntriesTable)
				.where(eq(reportEntriesTable.uploadId, previousUpload.id));

			continue;
		}

		/*
		 * Ambil periode data dari upload sebelumnya.
		 */
		const previousEntries = await db
			.select({
				week: reportEntriesTable.week,
				month: reportEntriesTable.month,
				year: reportEntriesTable.year,
			})
			.from(reportEntriesTable)
			.where(eq(reportEntriesTable.uploadId, previousUpload.id));

		if (previousEntries.length === 0) {
			continue;
		}

		const previousPeriods = new Set(
			previousEntries.map((entry) => entry.year * 100 + entry.month),
		);

		const previousLatestPeriod = Math.max(...previousPeriods);

		/*
		 * ==========================================================
		 * UPLOAD BARU LEBIH LAMA
		 * ==========================================================
		 *
		 * Contoh:
		 *
		 * Existing : September 2026
		 * New      : August 2026
		 *
		 * Jangan menghapus September.
		 */
		if (previousLatestPeriod > newLatestPeriod) {
			continue;
		}

		/*
		 * ==========================================================
		 * PERIODE SAMA
		 * ==========================================================
		 *
		 * Contoh:
		 *
		 * Existing : September upload lama
		 * New      : September upload baru
		 *
		 * Upload lama harus menjadi inactive.
		 */
		if (previousLatestPeriod === newLatestPeriod) {
			await db
				.delete(reportEntriesTable)
				.where(eq(reportEntriesTable.uploadId, previousUpload.id));

			continue;
		}

		/*
		 * ==========================================================
		 * PERIODE LAMA
		 * ==========================================================
		 *
		 * Contoh:
		 *
		 * Existing:
		 *   August W31
		 *   August W32
		 *   August W33
		 *   August W34
		 *   August W35
		 *   August W36  <-- partial / cross-month
		 *
		 * New:
		 *   September W36
		 *   September W37
		 *   September W38
		 *
		 * Maka:
		 *
		 *   W31-W35 August → DELETE
		 *   W36 August     → KEEP
		 *
		 * Karena W36 masih terdapat pada data periode baru.
		 */

		const entriesToDelete = previousEntries.filter((entry) => {
			const entryPeriod = entry.year * 100 + entry.month;

			/*
			 * Data dari periode yang sama dengan periode baru
			 * tidak masuk ke sini karena previousLatestPeriod
			 * sudah lebih kecil dari newLatestPeriod.
			 *
			 * Untuk periode lama, hanya pertahankan week yang
			 * juga muncul pada upload baru.
			 *
			 * Ini menangani week lintas bulan.
			 */
			if (entryPeriod < newLatestPeriod) {
				return !newWeeks.has(entry.week);
			}

			return false;
		});

		if (entriesToDelete.length === 0) {
			continue;
		}

		/*
		 * Hapus berdasarkan:
		 * uploadId + year + month + week
		 *
		 * Jadi kita tidak melakukan global delete terhadap
		 * week yang sama.
		 */
		for (const entry of entriesToDelete) {
			await db.delete(reportEntriesTable).where(
				sql`
            ${reportEntriesTable.uploadId} = ${previousUpload.id}
            AND ${reportEntriesTable.year} = ${entry.year}
            AND ${reportEntriesTable.month} = ${entry.month}
            AND ${reportEntriesTable.week} = ${entry.week}
          `,
			);
		}
	}
}

async function saveParsedEntries(
	entries: ParsedEntry[],
	rowsProcessed: number,
	options: {
		filename: string;
		sourceType: "manual" | "google_sheet";
		sourceUrl?: string;
		sourceId?: string;
	},
) {
	const uniqueEntries = new Map<string, ParsedEntry>();

	for (const e of entries) {
		uniqueEntries.set(`${e.sourceId}|${e.type}|${e.subType ?? ""}`, e);
	}

	const deduped = Array.from(uniqueEntries.values());

	const weeksFound = Array.from(new Set(deduped.map((e) => e.week))).sort();

	// Hapus data lama untuk week yang terdapat pada data terbaru.
	await reconcileBeforeUpload(deduped, weeksFound, {
		sourceType: options.sourceType,
		sourceId: options.sourceId,
	});

	const [uploadRecord] = await db
		.insert(excelUploadsTable)
		.values({
			filename: options.filename,
			sourceType: options.sourceType,
			sourceUrl: options.sourceUrl ?? null,
			sourceId: options.sourceId ?? null,
			lastSyncedAt: options.sourceType === "google_sheet" ? new Date() : null,
			weeksFound,
			rowsProcessed,
		})
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

	return {
		uploadId: uploadRecord.id,
		weeksFound,
		rowsProcessed,
		minergoRows: deduped.length,
	};
}

router.post(
	"/upload/google-sheet/test-stream",
	async (req, res): Promise<void> => {
		try {
			const { url } = req.body as { url?: string };

			if (!url) {
				res.status(400).json({
					error: "Google Spreadsheet URL is required",
				});
				return;
			}

			const spreadsheetId = extractGoogleSpreadsheetId(url);

			if (!spreadsheetId) {
				res.status(400).json({
					error: "Invalid Google Spreadsheet URL",
				});
				return;
			}

			req.log.info(
				{ spreadsheetId },
				"Testing streaming Google Drive XLSX parser",
			);

			const result = await parseGoogleDriveXlsx(spreadsheetId);

			res.json({
				success: true,
				spreadsheetId,
				...result,
			});
		} catch (err) {
			req.log.error({ err }, "Streaming Google Drive XLSX test failed");

			res.status(500).json({
				error: String(err),
			});
		}
	},
);

router.post(
	"/upload/google-sheet/test-api",
	async (req, res): Promise<void> => {
		try {
			const { url } = req.body as { url?: string };

			if (!url) {
				res.status(400).json({
					error: "Google Spreadsheet URL is required",
				});
				return;
			}

			const spreadsheetId = extractGoogleSpreadsheetId(url);

			if (!spreadsheetId) {
				res.status(400).json({
					error: "Invalid Google Spreadsheet URL",
				});
				return;
			}

			req.log.info({ spreadsheetId }, "Testing Google Drive metadata access");

			const file = await getGoogleDriveFile(spreadsheetId);

			res.json({
				success: true,
				spreadsheetId,
				file,
			});
		} catch (err) {
			req.log.error({ err }, "Google Drive metadata test failed");

			res.status(500).json({
				error: String(err),
			});
		}
	},
);

router.post(
	"/upload/google-sheet/test-api",
	async (req, res): Promise<void> => {
		try {
			const { url } = req.body as { url?: string };

			if (!url) {
				res.status(400).json({
					error: "Google Spreadsheet URL is required",
				});
				return;
			}

			const spreadsheetId = extractGoogleSpreadsheetId(url);

			if (!spreadsheetId) {
				res.status(400).json({
					error: "Invalid Google Spreadsheet URL",
				});
				return;
			}

			req.log.info({ spreadsheetId }, "Testing Google Drive API access");

			const file = await testGoogleDriveFile(spreadsheetId);

			res.json({
				success: true,
				spreadsheetId,
				file,
			});
		} catch (err) {
			req.log.error({ err }, "Google Drive API test failed");

			res.status(500).json({
				error: String(err),
			});
		}
	},
);

router.post("/upload/google-sheet", async (req, res): Promise<void> => {
	try {
		const { url } = req.body as { url?: string };

		if (!url) {
			res.status(400).json({
				error: "Google Spreadsheet URL is required",
			});
			return;
		}

		const spreadsheetId = extractGoogleSpreadsheetId(url);

		if (!spreadsheetId) {
			res.status(400).json({
				error: "Invalid Google Spreadsheet URL",
			});
			return;
		}

		req.log.info({ spreadsheetId }, "Processing Google Spreadsheet upload");

		const result = await saveGoogleSheetData(spreadsheetId, url);

		req.log.info(
			{
				uploadId: result.uploadId,
				spreadsheetId,
				minergoRows: result.entries,
				weeks: result.weeksFound,
			},
			"Google Spreadsheet processed",
		);

		res.json({
			success: true,
			sourceType: "google_sheet",
			uploadId: result.uploadId,
			spreadsheetId,
			weeksFound: result.weeksFound,
			rowsProcessed: result.rowsProcessed,
			minergoRows: result.entries,
		});
	} catch (err) {
		req.log.error({ err }, "Google Spreadsheet upload failed");

		res.status(500).json({
			error: String(err),
		});
	}
});

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

			const result = await saveParsedEntries(entries, rowsProcessed, {
				filename: req.file.originalname,
				sourceType: "manual",
			});

			req.log.info(
				{
					uploadId: result.uploadId,
					minergoRows: result.minergoRows,
					weeks: result.weeksFound,
				},
				"Upload processed",
			);

			res.json({
				uploadId: result.uploadId,
				weeksFound: result.weeksFound,
				rowsProcessed: result.rowsProcessed,
				minergoRows: result.minergoRows,
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

router.delete("/uploads/:id", async (req, res): Promise<void> => {
	try {
		const uploadId = Number(req.params.id);

		if (!Number.isInteger(uploadId) || uploadId <= 0) {
			res.status(400).json({
				success: false,
				error: "Invalid upload ID",
			});
			return;
		}

		const [uploadRecord] = await db
			.select()
			.from(excelUploadsTable)
			.where(eq(excelUploadsTable.id, uploadId))
			.limit(1);

		if (!uploadRecord) {
			res.status(404).json({
				success: false,
				error: "Upload data not found",
			});
			return;
		}

		await db.transaction(async (tx) => {
			await tx
				.delete(reportEntriesTable)
				.where(eq(reportEntriesTable.uploadId, uploadId));

			await tx
				.delete(excelUploadsTable)
				.where(eq(excelUploadsTable.id, uploadId));
		});

		res.json({
			success: true,
			uploadId,
			filename: uploadRecord.filename,
			sourceType: uploadRecord.sourceType,
			message: "Upload data deleted successfully",
		});
	} catch (error) {
		console.error("Failed to delete upload", error);

		res.status(500).json({
			success: false,
			error: "Failed to delete upload data",
		});
	}
});

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
