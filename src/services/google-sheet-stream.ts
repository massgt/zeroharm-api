import ExcelJS from "exceljs";
import type { Readable } from "node:stream";

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

function cellValue(value: ExcelJS.CellValue): unknown {
	if (value === null || value === undefined) {
		return "";
	}

	if (typeof value === "object") {
		if ("result" in value) {
			return value.result ?? "";
		}

		if ("text" in value) {
			return value.text ?? "";
		}
	}

	return value;
}

function text(value: ExcelJS.CellValue): string {
	return String(cellValue(value) ?? "").trim();
}

function number(value: ExcelJS.CellValue): number {
	const parsed = Number(cellValue(value));
	return Number.isFinite(parsed) ? parsed : 0;
}

function excelDateToYear(value: ExcelJS.CellValue): number {
	const raw = cellValue(value);

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

function normalizeOPKSubType(value: ExcelJS.CellValue): OPKSubType | undefined {
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
		// 1. GET GOOGLE DRIVE METADATA
		const metadataStartedAt = performance.now();

		logGoogleSheetStage("drive_metadata_started", metadataStartedAt, {
			fileId,
		});

		const file = await getGoogleDriveFile(fileId);

		logGoogleSheetStage("drive_metadata_completed", metadataStartedAt, {
			mimeType: file.mimeType,
		});

		if (
			file.mimeType !==
			"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
		) {
			throw new Error(`Unsupported Google Drive file type: ${file.mimeType}`);
		}

		// 2. DOWNLOAD XLSX
		const downloadStartedAt = performance.now();

		logGoogleSheetStage("drive_download_started", downloadStartedAt, {
			fileId,
		});

		const stream = await downloadGoogleDriveFile(fileId);

		logGoogleSheetStage("drive_download_completed", downloadStartedAt);

		// 3. INITIALIZE STREAMING WORKBOOK
		const workbookStartedAt = performance.now();

		const workbook = new ExcelJS.stream.xlsx.WorkbookReader(
			stream as Readable,
			{
				entries: "ignore",
				sharedStrings: "cache",
				styles: "ignore",
				hyperlinks: "ignore",
				worksheets: "emit",
			},
		);

		logGoogleSheetStage("workbook_initialized", workbookStartedAt);

		let rowsProcessed = 0;
		let entries = 0;
		let callbackDurationMs = 0;

		const attendanceEntries: ParsedGoogleAttendanceEntry[] = [];
		const sheetsProcessed: string[] = [];

		const allowedSheets = [
			"Hazard",
			"Inspeksi",
			"Observasi",
			"OPK",
			"Attendance",
		];

		// 4. STREAM WORKSHEETS
		for await (const worksheetReader of workbook) {
			const sheetName = String(
				(worksheetReader as unknown as { name?: string }).name ?? "",
			);

			if (!allowedSheets.includes(sheetName)) {
				continue;
			}

			const sheetStartedAt = performance.now();

			let rowsRead = 0;
			let rowsAccepted = 0;

			sheetsProcessed.push(sheetName);
			logGoogleSheetStage("worksheet_started", sheetStartedAt, {
				sheet: sheetName,
			});

			for await (const row of worksheetReader) {
				if (row.number === 1) {
					continue;
				}

				rowsRead++;

				if (rowsRead % 10000 === 0) {
					logGoogleSheetStage("worksheet_progress", sheetStartedAt, {
						sheet: sheetName,
						rowsRead,
						rowsAccepted,
					});
				}

				let entry: ParsedGoogleEntry | undefined;

				// ATTENDANCE
				if (sheetName === "Attendance") {
					const company = row.getCell(12).value;

					if (!isMinergoCompany(company)) continue;

					const nik = text(row.getCell(7).value);
					if (!nik) continue;

					const eventDate = getGoogleAttendanceEventDate(row.getCell(2).value);
					if (!eventDate) continue;

					const eventType = text(row.getCell(4).value);

					const allowedEventTypes = [
						"P5M, Sosialisasi IBPR, dan Sosialisasi Golden Rules",
						"Safety Talk, Sosialisasi IBPR, dan Sosialisasi Golden Rules",
						"Sosialisasi Golden Rules",
						"Sosialisasi IBPR",
					];

					if (!allowedEventTypes.includes(eventType)) continue;

					const week = text(row.getCell(17).value);
					if (!week) continue;

					const month = number(row.getCell(18).value);

					if (!Number.isInteger(month) || month < 1 || month > 12) {
						continue;
					}

					const year = Number(eventDate.slice(0, 4));

					attendanceEntries.push({
						nik,
						eventDate,
						eventType,
						week,
						month,
						year,
					});

					rowsAccepted++;
					continue;
				}

				// HAZARD
				if (sheetName === "Hazard") {
					const company = text(row.getCell(7).value);
					if (company !== COMPANY) continue;

					const nik = text(row.getCell(3).value);
					const sourceId = text(row.getCell(1).value);
					const week = text(row.getCell(32).value);

					if (!nik || !sourceId || !week) continue;

					entry = {
						sourceId: `haz_${sourceId}`,
						type: "hazard",
						nik,
						week,
						month: number(row.getCell(33).value),
						year: excelDateToYear(row.getCell(23).value),
					};

					const jenisTemuan = text(row.getCell(16).value).toUpperCase();

					if (jenisTemuan === "TTA") {
						const callbackStartedAt = performance.now();

						await onEntry?.({
							...entry,
							sourceId: `tta_${sourceId}`,
							type: "tta",
						});

						callbackDurationMs += performance.now() - callbackStartedAt;

						entries++;
					}
				}

				// INSPEKSI
				if (sheetName === "Inspeksi") {
					const company = text(row.getCell(5).value);
					if (company !== COMPANY) continue;

					const nik = text(row.getCell(3).value);
					const sourceId = text(row.getCell(7).value);
					const week = text(row.getCell(23).value);

					if (!nik || !sourceId || !week) continue;

					entry = {
						sourceId: `ins_${sourceId}`,
						type: "inspeksi",
						nik,
						week,
						month: number(row.getCell(24).value),
						year: excelDateToYear(row.getCell(17).value),
						timeCompliance: text(row.getCell(26).value),
					};
				}

				// OBSERVASI
				if (sheetName === "Observasi") {
					const company = text(row.getCell(23).value);
					if (company !== COMPANY) continue;

					const nik = text(row.getCell(19).value);
					const sourceId = text(row.getCell(1).value);
					const week = text(row.getCell(24).value);

					if (!nik || !sourceId || !week) continue;

					entry = {
						sourceId: `obs_${sourceId}`,
						type: "observasi",
						nik,
						week,
						month: number(row.getCell(25).value),
						year: excelDateToYear(row.getCell(6).value),
					};
				}

				// OPK
				if (sheetName === "OPK") {
					const company = text(row.getCell(4).value);
					if (company !== COMPANY) continue;

					const nik = text(row.getCell(3).value);
					const sourceId = text(row.getCell(1).value);
					const week = text(row.getCell(19).value);

					if (!nik || !sourceId || !week) continue;

					const status = number(row.getCell(18).value);
					if (status !== 1) continue;

					const subType = normalizeOPKSubType(row.getCell(16).value);
					if (!subType) continue;

					entry = {
						sourceId: `opk_${sourceId}`,
						type: "opk",
						subType,
						nik,
						week,
						month: number(row.getCell(20).value),
						year: excelDateToYear(row.getCell(17).value),
					};
				}

				// FORWARD SAP ENTRY
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

		// 5. PARSING COMPLETED
		logGoogleSheetStage("parser_completed", totalStartedAt, {
			sheetsProcessed,
			sapEntries: entries,
			attendanceEntries: attendanceEntries.length,
			rowsProcessed,
			callbackDurationMs: Math.round(callbackDurationMs),
		});

		return {
			rowsProcessed,
			entries,
			attendanceEntries,
			sheetsProcessed,
		};
	} catch (error) {
		logGoogleSheetStage("parser_failed", totalStartedAt, {
			error: error instanceof Error ? error.message : String(error),
		});

		throw error;
	}
}
