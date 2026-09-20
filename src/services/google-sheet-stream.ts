import ExcelJS from "exceljs";
import type { Readable } from "node:stream";

import { downloadGoogleDriveFile, getGoogleDriveFile } from "./google-drive.js";

const COMPANY = "PT. Minergo Visi Maxima";

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

export async function parseGoogleDriveXlsx(
	fileId: string,
	onEntry?: (entry: ParsedGoogleEntry) => Promise<void> | void,
): Promise<{
	rowsProcessed: number;
	entries: number;
	sheetsProcessed: string[];
}> {
	const file = await getGoogleDriveFile(fileId);

	if (
		file.mimeType !==
		"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
	) {
		throw new Error(`Unsupported Google Drive file type: ${file.mimeType}`);
	}

	const stream = await downloadGoogleDriveFile(fileId);

	const workbook = new ExcelJS.stream.xlsx.WorkbookReader(stream as Readable, {
		entries: "ignore",
		sharedStrings: "cache",
		styles: "ignore",
		hyperlinks: "ignore",
		worksheets: "emit",
	});

	let rowsProcessed = 0;
	let entries = 0;

	const sheetsProcessed: string[] = [];

	for await (const worksheetReader of workbook) {
		const sheetName = String(
			(worksheetReader as unknown as { name?: string }).name ?? "",
		);

		if (
			sheetName !== "Hazard" &&
			sheetName !== "Inspeksi" &&
			sheetName !== "Observasi" &&
			sheetName !== "OPK"
		) {
			continue;
		}

		sheetsProcessed.push(sheetName);

		for await (const row of worksheetReader) {
			if (row.number === 1) {
				continue;
			}

			let entry: ParsedGoogleEntry | undefined;

			if (sheetName === "Hazard") {
				const company = text(row.getCell(7).value);

				if (company !== COMPANY) {
					continue;
				}

				const nik = text(row.getCell(3).value);
				const sourceId = text(row.getCell(1).value);

				const week = text(row.getCell(32).value);

				if (!nik || !sourceId || !week) {
					continue;
				}

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
					await onEntry?.({
						...entry,
						sourceId: `tta_${sourceId}`,
						type: "tta",
					});

					entries++;
				}
			}

			if (sheetName === "Inspeksi") {
				const company = text(row.getCell(5).value);

				if (company !== COMPANY) {
					continue;
				}

				const nik = text(row.getCell(3).value);
				const sourceId = text(row.getCell(7).value);
				const week = text(row.getCell(23).value);

				if (!nik || !sourceId || !week) {
					continue;
				}

				const timeCompliance = text(row.getCell(26).value);

				entry = {
					sourceId: `ins_${sourceId}`,
					type: "inspeksi",
					nik,
					week,
					month: number(row.getCell(24).value),
					year: excelDateToYear(row.getCell(17).value),
					timeCompliance,
				};
			}

			if (sheetName === "Observasi") {
				const company = text(row.getCell(23).value);

				if (company !== COMPANY) {
					continue;
				}

				const nik = text(row.getCell(19).value);
				const sourceId = text(row.getCell(1).value);
				const week = text(row.getCell(24).value);

				if (!nik || !sourceId || !week) {
					continue;
				}

				entry = {
					sourceId: `obs_${sourceId}`,
					type: "observasi",
					nik,
					week,
					month: number(row.getCell(25).value),
					year: excelDateToYear(row.getCell(6).value),
				};
			}

			if (sheetName === "OPK") {
				const company = text(row.getCell(4).value);

				if (company !== COMPANY) {
					continue;
				}

				const nik = text(row.getCell(3).value);
				const sourceId = text(row.getCell(1).value);
				const week = text(row.getCell(19).value);

				if (!nik || !sourceId || !week) {
					continue;
				}

				const status = number(row.getCell(18).value);

				if (status !== 1) {
					continue;
				}

				const subType = normalizeOPKSubType(row.getCell(16).value);

				if (!subType) {
					continue;
				}

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

			if (entry) {
				await onEntry?.(entry);
				entries++;
				rowsProcessed++;
			}
		}
	}

	return {
		rowsProcessed,
		entries,
		sheetsProcessed,
	};
}
