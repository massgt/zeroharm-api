import { getGoogleSheetValuesBatch } from "./google-sheets.js";
import { createWriteStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import { SaxesParser } from "saxes";
// @ts-ignore unzipper does not ship TypeScript declarations
import unzipper from "unzipper";


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



const SHEET_COLUMNS = {
  Hazard: ["A","C","G","P","W","AF","AG"], Inspeksi: ["C","E","G","Q","W","X","Z"],
  Observasi: ["A","F","S","W","X","Y"], OPK: ["A","C","D","P","Q","R","S","T"], Attendance: ["B","D","G","L","Q","R"],
} as const;
const COLUMN_INDEX: Record<string,number> = {A:0,B:1,C:2,D:3,E:4,F:5,G:6,H:7,I:8,J:9,K:10,L:11,M:12,N:13,O:14,P:15,Q:16,R:17,S:18,T:19,U:20,V:21,W:22,X:23,Y:24,Z:25,AA:26,AB:27,AC:28,AD:29,AE:30,AF:31,AG:32};

async function parseSelectedColumns(data:Map<string,Map<string,unknown[]>>,onEntry?:(entry:ParsedGoogleEntry)=>Promise<void>|void){
 const started=performance.now(),attendanceEntries:ParsedGoogleAttendanceEntry[]=[],sheetsProcessed:string[]=[];let rowsProcessed=0,entries=0;
 const norm=(v:unknown)=>String(v??"").toUpperCase().replace(/[^A-Z0-9]/g,"");
 const allowed=new Set(["SAFETYTALK","SAFETYTALKSOSIALISASIIBPRDANSOSIALISASIGOLDENRULES","P5MSOSIALISASIIBPRDANSOSIALISASIGOLDENRULES","SOSIALISASIGOLDENRULES","SOSIALISASIIBPR"]);
 for(const sheet of Object.keys(SHEET_COLUMNS) as (keyof typeof SHEET_COLUMNS)[]){const cols=data.get(sheet);if(!cols)continue;const max=Math.max(0,...Array.from(cols.values(),v=>v.length));let accepted=0;
  for(let ri=1;ri<max;ri++){const row:unknown[]=[];for(const col of SHEET_COLUMNS[sheet])row[COLUMN_INDEX[col]]=cols.get(col)?.[ri]??"";
   if(sheet==="Attendance"){if(!isMinergoCompany(row[11]))continue;const nik=text(row[6]),date=getGoogleAttendanceEventDate(row[1]),type=text(row[3]),week=text(row[16]),month=number(row[17]);if(!nik||!date||!week||!Number.isInteger(month)||month<1||month>12||!allowed.has(norm(type)))continue;attendanceEntries.push({nik,eventDate:date,eventType:type,week,month,year:Number(date.slice(0,4))});accepted++;continue;}
   let e:ParsedGoogleEntry|undefined;
   if(sheet==="Hazard"){if(!isMinergoCompany(row[6]))continue;const nik=text(row[2]),id=text(row[0]),week=text(row[31]);if(!nik||!id||!week)continue;e={sourceId:"haz_"+id,type:"hazard",nik,week,month:number(row[32]),year:excelDateToYear(row[22])};if(text(row[15]).toUpperCase()==="TTA"){await onEntry?.({...e,sourceId:"tta_"+id,type:"tta"});entries++;}}
   else if(sheet==="Inspeksi"){if(!isMinergoCompany(row[4]))continue;const nik=text(row[2]),id=text(row[6]),week=text(row[22]);if(!nik||!id||!week)continue;e={sourceId:"ins_"+id,type:"inspeksi",nik,week,month:number(row[23]),year:excelDateToYear(row[16]),timeCompliance:text(row[25])};}
   else if(sheet==="Observasi"){if(!isMinergoCompany(row[22]))continue;const nik=text(row[18]),id=text(row[0]),week=text(row[23]);if(!nik||!id||!week)continue;e={sourceId:"obs_"+id,type:"observasi",nik,week,month:number(row[24]),year:excelDateToYear(row[5])};}
   else if(sheet==="OPK"){if(!isMinergoCompany(row[3]))continue;const nik=text(row[2]),id=text(row[0]),week=text(row[18]);if(!nik||!id||!week||number(row[17])!==1)continue;const sub=normalizeOPKSubType(row[15]);if(!sub)continue;e={sourceId:"opk_"+id,type:"opk",subType:sub,nik,week,month:number(row[19]),year:excelDateToYear(row[16])};}
   if(e){await onEntry?.(e);entries++;rowsProcessed++;accepted++;}
  }sheetsProcessed.push(sheet);logGoogleSheetStage("worksheet_completed",started,{sheet,rowsRead:Math.max(0,max-1),rowsAccepted:accepted});
 }logGoogleSheetStage("parser_completed",started,{sheetsProcessed,entries,attendanceEntries:attendanceEntries.length,rowsProcessed});return{rowsProcessed,entries,attendanceEntries,sheetsProcessed};
}

function parseXmlEntry(
	stream: NodeJS.ReadableStream,
	onOpen: (name: string, attributes: Record<string, string>) => void,
	onText: (value: string) => void,
	onClose: (name: string) => void,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const parser = new SaxesParser({ xmlns: false });
		const decoder = new StringDecoder("utf8");
		let settled = false;
		const fail = (error: unknown) => {
			if (settled) return;
			settled = true;
			reject(error);
		};
		parser.on("opentag", (tag) => onOpen(tag.name, tag.attributes as Record<string, string>));
		parser.on("text", onText);
		parser.on("closetag", (tag) => onClose(tag.name));
		parser.on("error", fail);
		stream.on("error", fail);
		stream.on("data", (chunk: Buffer) => {
			try { parser.write(decoder.write(chunk)); } catch (error) { fail(error); }
		});
		stream.on("end", () => {
			try {
				parser.write(decoder.end());
				parser.close();
				if (!settled) { settled = true; resolve(); }
			} catch (error) { fail(error); }
		});
	});
}

async function readSharedStrings(entry: any): Promise<string[]> {
	const values: string[] = [];
	let current: string[] | undefined;
	await parseXmlEntry(
		entry.stream(),
		(name) => { if (name === "si") current = []; },
		(value) => { if (current) current.push(value); },
		(name) => {
			if (name === "si" && current) {
				values.push(current.join(""));
				current = undefined;
			}
		},
	);
	return values;
}

async function readWorkbookSheets(workbookEntry: any, relationshipsEntry: any): Promise<Map<string, string>> {
	const relationshipTargets = new Map<string, string>();
	await parseXmlEntry(
		relationshipsEntry.stream(),
		(name, attributes) => {
			if (name === "Relationship" && attributes.Id && attributes.Target) {
				relationshipTargets.set(attributes.Id, attributes.Target);
			}
		},
		() => {},
		() => {},
	);
	const sheets = new Map<string, string>();
	await parseXmlEntry(
		workbookEntry.stream(),
		(name, attributes) => {
			if (name === "sheet" && attributes.name && attributes["r:id"]) {
				const target = relationshipTargets.get(attributes["r:id"]);
				if (target) {
					const normalized = path.posix.normalize(
						target.startsWith("/") ? target.slice(1) : path.posix.join("xl", target),
					);
					sheets.set(attributes.name, normalized);
				}
			}
		},
		() => {},
		() => {},
	);
	return sheets;
}

function columnNameFromCellReference(reference: string): string {
	return reference.match(/^[A-Z]+/)?.[0] ?? "";
}

async function readWorksheetColumns(entry: any, columns: readonly string[], sharedStrings: string[]): Promise<Map<string, unknown[]>> {
	const selected = new Set<string>(columns);
	const values = new Map<string, unknown[]>(columns.map((column) => [column, [] as unknown[]]));
	let row: Map<string, unknown> | undefined;
	let cellColumn: string | undefined;
	let cellType = "";
	let cellValue = "";
	let inValue = false;
	await parseXmlEntry(
		entry.stream(),
		(name, attributes) => {
			if (name === "row") row = new Map<string, unknown>();
			if (name === "c" && row) {
				const column = columnNameFromCellReference(attributes.r ?? "");
				cellColumn = selected.has(column) ? column : undefined;
				cellType = attributes.t ?? "";
				cellValue = "";
			}
			if (name === "v" || name === "t") inValue = true;
		},
		(value) => { if (cellColumn && inValue) cellValue += value; },
		(name) => {
			if (name === "v" || name === "t") inValue = false;
			if (name === "c" && row && cellColumn) {
				let value: unknown = cellValue;
				if (cellType === "s") {
					const index = Number(cellValue);
					value = Number.isInteger(index) ? sharedStrings[index] ?? "" : "";
				} else if (cellType === "inlineStr" || cellType === "str") {
					value = cellValue;
				} else if (cellType === "b") {
					value = cellValue === "1";
				} else if (cellValue !== "" && Number.isFinite(Number(cellValue))) {
					value = Number(cellValue);
				}
				row.set(cellColumn, value);
				cellColumn = undefined;
			}
			if (name === "row" && row) {
				for (const column of columns) values.get(column)!.push(row.get(column) ?? "");
				row = undefined;
			}
		},
	);
	return values;
}

async function parseOfficeXlsx(fileId: string, onEntry?: (entry: ParsedGoogleEntry) => Promise<void> | void) {
	const started = performance.now();
	const drive = await import("./google-drive.js");
	const source = await drive.downloadGoogleDriveFile(fileId);
	const tempPath = path.join(tmpdir(), "bib-xlsx-" + randomUUID() + ".xlsx");
	try {
		await pipeline(source as NodeJS.ReadableStream, createWriteStream(tempPath));
		logGoogleSheetStage("office_xlsx_download_completed", started, {
			fileId,
			fileSizeBytes: (await stat(tempPath)).size,
		});
		const archive = await unzipper.Open.file(tempPath);
		const getEntry = (entryPath: string) => archive.files.find((entry: any) => entry.path === entryPath);
		const workbookEntry = getEntry("xl/workbook.xml");
		const relationshipsEntry = getEntry("xl/_rels/workbook.xml.rels");
		const sharedStringsEntry = getEntry("xl/sharedStrings.xml");
		if (!workbookEntry || !relationshipsEntry || !sharedStringsEntry) {
			throw new Error("Struktur XLSX tidak lengkap (workbook, relasi, atau shared strings tidak ditemukan).");
		}
		const sheetPaths = await readWorkbookSheets(workbookEntry, relationshipsEntry);
		const sharedStrings = await readSharedStrings(sharedStringsEntry);
		logGoogleSheetStage("office_xlsx_shared_strings_loaded", started, { sharedStringCount: sharedStrings.length });
		const totals = {
			rowsProcessed: 0,
			entries: 0,
			attendanceEntries: [] as ParsedGoogleAttendanceEntry[],
			sheetsProcessed: [] as string[],
		};
		for (const sheet of Object.keys(SHEET_COLUMNS) as (keyof typeof SHEET_COLUMNS)[]) {
			const sheetPath = sheetPaths.get(sheet);
			if (!sheetPath) continue;
			const worksheetEntry = getEntry(sheetPath);
			if (!worksheetEntry) throw new Error("Worksheet " + sheet + " tidak ditemukan di arsip XLSX.");
			const data = new Map<string, Map<string, unknown[]>>();
			data.set(sheet, await readWorksheetColumns(worksheetEntry, SHEET_COLUMNS[sheet], sharedStrings));
			const result = await parseSelectedColumns(data, onEntry);
			totals.rowsProcessed += result.rowsProcessed;
			totals.entries += result.entries;
			totals.attendanceEntries.push(...result.attendanceEntries);
			totals.sheetsProcessed.push(...result.sheetsProcessed);
			logGoogleSheetStage("office_xlsx_worksheet_released", started, {
				sheet,
				entries: result.entries,
				attendanceEntries: result.attendanceEntries.length,
			});
		}
		logGoogleSheetStage("office_xlsx_parser_completed", started, totals);
		return totals;
	} finally {
		await unlink(tempPath).catch(() => {});
	}
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
	const started = performance.now();
	const drive = await import("./google-drive.js");
	const file = await drive.getGoogleDriveFile(fileId);
	logGoogleSheetStage("drive_metadata_completed", started, {
		mimeType: file.mimeType,
		fileSizeBytes: file.size ? Number(file.size) : null,
	});
	if (file.mimeType !== "application/vnd.google-apps.spreadsheet") {
		if (file.mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
			return parseOfficeXlsx(fileId, onEntry);
		}
		throw new Error("Format file Drive tidak didukung: " + file.mimeType);
	}
	const totals = {
		rowsProcessed: 0,
		entries: 0,
		attendanceEntries: [] as ParsedGoogleAttendanceEntry[],
		sheetsProcessed: [] as string[],
	};
	for (const sheet of Object.keys(SHEET_COLUMNS) as (keyof typeof SHEET_COLUMNS)[]) {
		const columns = SHEET_COLUMNS[sheet];
		const ranges = columns.map((col) => "'" + sheet + "'!" + col + ":" + col);
		const values = await getGoogleSheetValuesBatch(fileId, ranges);
		const byColumn = new Map<string, unknown[]>();
		for (let i = 0; i < columns.length; i++) byColumn.set(columns[i], values[i] ?? []);
		const data = new Map<string, Map<string, unknown[]>>();
		data.set(sheet, byColumn);
		const result = await parseSelectedColumns(data, onEntry);
		totals.rowsProcessed += result.rowsProcessed;
		totals.entries += result.entries;
		totals.attendanceEntries.push(...result.attendanceEntries);
		totals.sheetsProcessed.push(...result.sheetsProcessed);
		logGoogleSheetStage("worksheet_released", started, {
			sheet,
			attendanceRows: result.attendanceEntries.length,
			parsedEntries: result.entries,
		});
	}
	logGoogleSheetStage("parser_completed", started, totals);
	return totals;
}
