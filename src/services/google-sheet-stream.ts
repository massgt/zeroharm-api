import * as xlsx from "xlsx";

import { downloadGoogleDriveFile, getGoogleDriveFile } from "./google-drive.js";

const COMPANY = "PT. Minergo Visi Maxima";

function normalizeCompanyName(value: unknown): string {
	return String(value ?? "")
		.toUpperCase()
		.replace(/[^A-Z0-9]/g, "");
}

function isMinergoCompany(value: unknown): boolean {
	return normalizeCompanyName(value) === normalizeCompanyName(COMPANY);
}

function getGoogleAttendanceEventDate(value: unknown): string | undefined {
	if (value instanceof Date && !Number.isNaN(value.getTime())) {
		return [
			value.getFullYear(),
			String(value.getMonth() + 1).padStart(2, "0"),
			String(value.getDate()).padStart(2, "0"),
		].join("-");
	}

	if (typeof value === "number" && Number.isFinite(value)) {
		const date = new Date(Date.UTC(1899, 11, 30) + value * 86400000);

		return date.toISOString().slice(0, 10);
	}

	const raw = String(value ?? "").trim();

	const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);

	if (isoMatch) {
		return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
	}

	const localMatch = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);

	if (localMatch) {
		const day = Number(localMatch[1]);
		const month = Number(localMatch[2]);
		const year = Number(localMatch[3]);

		const date = new Date(Date.UTC(year, month - 1, day));

		if (
			date.getUTCFullYear() === year &&
			date.getUTCMonth() === month - 1 &&
			date.getUTCDate() === day
		) {
			return [
				year,
				String(month).padStart(2, "0"),
				String(day).padStart(2, "0"),
			].join("-");
		}
	}

	return undefined;
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

export interface ParsedGoogleEntry {
	sourceId: string;
	type: "tta" | "hazard" | "inspeksi" | "observasi" | "opk";
	subType?: OPKSubType;
	nik: string;
	week: string;
	month: number;
	year: number;
	timeCompliance?: string;
}
export interface ParsedGoogleAttendanceEntry {
	nik: string;
	eventDate: string;
	eventType: string;
	week: string;
	month: number;
	year: number;
}

function text(value: unknown): string {
	return String(value ?? "").trim();
}

function number(value: unknown): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

function excelDateToYear(raw: unknown): number {

	if (raw instanceof Date) {
		return raw.getFullYear();
	}

	if (typeof raw === "number") {
		const date = new Date(Date.UTC(1899, 11, 30) + raw * 86400000);
		return date.getUTCFullYear();
	}

	if (typeof raw === "string") {
		const year = new Date(raw).getFullYear();
		return year || new Date().getFullYear();
	}

	return new Date().getFullYear();
}

function normalizeOPKSubType(value: unknown): OPKSubType | undefined {
	const str = text(value).toLowerCase();

	if (str.includes("sidak p2h")) return "p2h";
	if (str.includes("seatbelt")) return "seatbelt";
	if (str.includes("simper")) return "simper";
	if (str.includes("roster")) return "roster";
	if (str.includes("fatigue")) return "fatigue";
	if (str.includes("lototo")) return "lototo";
	if (str.includes("keberadaan pengawas")) {
		return "keberadaan_pengawas";
	}
	if (str.includes("fungsi pengawas")) {
		return "fungsi_pengawas";
	}
	if (str.includes("sidak pencahayaan")) {
		return "pencahayaan";
	}

	return undefined;
}

function logGoogleSheetStage(
	stage: string,
	startedAt: number,
	details: Record<string, unknown> = {},
) {
	console.log(
		JSON.stringify({
			scope: "google_sheet_parser",
			stage,
			durationMs: Math.round(performance.now() - startedAt),
			timestamp: new Date().toISOString(),
			...details,
		}),
	);
}

async function downloadStreamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of stream as AsyncIterable<Buffer | Uint8Array | string>) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks);
}

export async function parseGoogleDriveXlsx(
	fileId: string,
	onEntry?: (entry: ParsedGoogleEntry) => Promise<void> | void,
): Promise<{
	rowsProcessed: number;
	entries: number;
	attendanceEntries: ParsedGoogleAttendanceEntry[];
	sheetsProcessed: string[];
}> {
	const totalStartedAt = performance.now();

	try {
		const metadataStartedAt = performance.now();
		logGoogleSheetStage("drive_metadata_started", metadataStartedAt, { fileId });

		const file = await getGoogleDriveFile(fileId);
		logGoogleSheetStage("drive_metadata_completed", metadataStartedAt, {
			mimeType: file.mimeType,
			fileSizeBytes: file.size ? Number(file.size) : null,
		});

		if (
			file.mimeType !==
			"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
		) {
			throw new Error(`Unsupported Google Drive file type: ${file.mimeType}`);
		}

		// ExcelJS WorkbookReader menulis worksheet XML sementara ke /tmp apabila
		// worksheet muncul sebelum sharedStrings.xml di dalam arsip XLSX.
		// Pada serverless runtime, file XML hasil ekstraksi dapat memenuhi /tmp.
		// Gunakan parser buffer SheetJS agar proses Google Sheet tidak membuat
		// file worksheet sementara di disk.
		const downloadStartedAt = performance.now();
		logGoogleSheetStage("drive_download_started", downloadStartedAt, { fileId });

		const stream = await downloadGoogleDriveFile(fileId);
		const workbookBuffer = await downloadStreamToBuffer(stream);

		logGoogleSheetStage("drive_download_completed", downloadStartedAt, {
			downloadedBytes: workbookBuffer.length,
		});

		const workbookStartedAt = performance.now();
		const workbook = xlsx.read(workbookBuffer, {
			type: "buffer",
			cellDates: true,
			cellStyles: false,
			cellFormula: false,
			cellHTML: false,
			cellNF: false,
			dense: true,
		});
		logGoogleSheetStage("workbook_initialized", workbookStartedAt, {
			sheets: workbook.SheetNames.length,
			downloadedBytes: workbookBuffer.length,
		});

		let rowsProcessed = 0;
		let entries = 0;
		let callbackDurationMs = 0;
		const attendanceEntries: ParsedGoogleAttendanceEntry[] = [];
		const sheetsProcessed: string[] = [];
		const allowedSheets = new Set([
			"Hazard",
			"Inspeksi",
			"Observasi",
			"OPK",
			"Attendance",
		]);

		for (const sheetName of workbook.SheetNames) {
			if (!allowedSheets.has(sheetName)) continue;

			const sheetStartedAt = performance.now();
			const worksheet = workbook.Sheets[sheetName];
			if (!worksheet) continue;

			const rows = xlsx.utils.sheet_to_json<unknown[]>(worksheet, {
				header: 1,
				defval: "",
				raw: true,
			});

			sheetsProcessed.push(sheetName);
			let rowsRead = 0;
			let rowsAccepted = 0;

			logGoogleSheetStage("worksheet_started", sheetStartedAt, {
				sheet: sheetName,
				rowCount: Math.max(0, rows.length - 1),
			});

			for (let rowIndex = 1; rowIndex < rows.length; rowIndex++) {
				const row = rows[rowIndex] ?? [];
				rowsRead++;

				if (rowsRead % 10000 === 0) {
					logGoogleSheetStage("worksheet_progress", sheetStartedAt, {
						sheet: sheetName,
						rowsRead,
						rowsAccepted,
					});
				}

				if (sheetName === "Attendance") {
					if (!isMinergoCompany(row[11])) continue;

					const nik = text(row[6]);
					if (!nik) continue;

					const eventDate = getGoogleAttendanceEventDate(row[1]);
					if (!eventDate) continue;

					const eventType = text(row[3]);
					const normalizeAttendanceEventType = (value: unknown) =>
						String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

					const allowedAttendanceEventTypes = new Set([
						"SAFETYTALK",
						"SAFETYTALKSOSIALISASIIBPRDANSOSIALISASIGOLDENRULES",
						"P5MSOSIALISASIIBPRDANSOSIALISASIGOLDENRULES",
						"SOSIALISASIGOLDENRULES",
						"SOSIALISASIIBPR",
					]);

					if (!allowedAttendanceEventTypes.has(normalizeAttendanceEventType(eventType))) {
						continue;
					}

					const week = text(row[16]);
					if (!week) continue;

					const month = number(row[17]);
					if (!Number.isInteger(month) || month < 1 || month > 12) continue;

					attendanceEntries.push({
						nik,
						eventDate,
						eventType,
						week,
						month,
						year: Number(eventDate.slice(0, 4)),
					});
					rowsAccepted++;
					continue;
				}

				let entry: ParsedGoogleEntry | undefined;

				if (sheetName === "Hazard") {
					if (text(row[6]) !== COMPANY) continue;
					const nik = text(row[2]);
					const sourceId = text(row[0]);
					const week = text(row[31]);
					if (!nik || !sourceId || !week) continue;

					entry = {
						sourceId: `haz_${sourceId}`,
						type: "hazard",
						nik,
						week,
						month: number(row[32]),
						year: excelDateToYear(row[22]),
					};

					if (text(row[15]).toUpperCase() === "TTA") {
						const callbackStartedAt = performance.now();
						await onEntry?.({
							...entry,
							sourceId: `tta_${sourceId}`,
							type: "tta",
						});
						callbackDurationMs += performance.now() - callbackStartedAt;
						entries++;
					}
				} else if (sheetName === "Inspeksi") {
					if (text(row[4]) !== COMPANY) continue;
					const nik = text(row[2]);
					const sourceId = text(row[6]);
					const week = text(row[22]);
					if (!nik || !sourceId || !week) continue;

					entry = {
						sourceId: `ins_${sourceId}`,
						type: "inspeksi",
						nik,
						week,
						month: number(row[23]),
						year: excelDateToYear(row[16]),
						timeCompliance: text(row[25]),
					};
				} else if (sheetName === "Observasi") {
					if (text(row[22]) !== COMPANY) continue;
					const nik = text(row[18]);
					const sourceId = text(row[0]);
					const week = text(row[23]);
					if (!nik || !sourceId || !week) continue;

					entry = {
						sourceId: `obs_${sourceId}`,
						type: "observasi",
						nik,
						week,
						month: number(row[24]),
						year: excelDateToYear(row[5]),
					};
				} else if (sheetName === "OPK") {
					if (text(row[3]) !== COMPANY) continue;
					const nik = text(row[2]);
					const sourceId = text(row[0]);
					const week = text(row[18]);
					if (!nik || !sourceId || !week) continue;
					if (number(row[17]) !== 1) continue;

					const subType = normalizeOPKSubType(row[15]);
					if (!subType) continue;

					entry = {
						sourceId: `opk_${sourceId}`,
						type: "opk",
						subType,
						nik,
						week,
						month: number(row[19]),
						year: excelDateToYear(row[16]),
					};
				}

				if (entry) {
					const callbackStartedAt = performance.now();
					await onEntry?.(entry);
					callbackDurationMs += performance.now() - callbackStartedAt;
					entries++;
					rowsProcessed++;
					rowsAccepted++;
				}
			}

			logGoogleSheetStage("worksheet_completed", sheetStartedAt, {
				sheet: sheetName,
				rowsRead,
				rowsAccepted,
				totalSapEntries: entries,
				totalAttendanceEntries: attendanceEntries.length,
			});
		}

		logGoogleSheetStage("parser_completed", totalStartedAt, {
			sheetsProcessed,
			sapEntries: entries,
			attendanceEntries: attendanceEntries.length,
			rowsProcessed,
			callbackDurationMs: Math.round(callbackDurationMs),
			downloadedBytes: workbookBuffer.length,
		});

		return { rowsProcessed, entries, attendanceEntries, sheetsProcessed };
	} catch (error) {
		logGoogleSheetStage("parser_failed", totalStartedAt, {
			error: error instanceof Error ? error.message : String(error),
		});
		throw error;
	}
}
