import { getGoogleSheetValuesBatch } from "./google-sheets.js";

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

export async function parseGoogleDriveXlsx(fileId:string,onEntry?:(entry:ParsedGoogleEntry)=>Promise<void>|void):Promise<{rowsProcessed:number;entries:number;attendanceEntries:ParsedGoogleAttendanceEntry[];sheetsProcessed:string[]}> {
 const started=performance.now(); const attendanceEntries:ParsedGoogleAttendanceEntry[]=[]; const sheetsProcessed:string[]=[]; let rowsProcessed=0,entries=0;
 const normalizeEvent=(v:unknown)=>String(v??"").toUpperCase().replace(/[^A-Z0-9]/g,"");
 const allowedEvents=new Set(["SAFETYTALK","SAFETYTALKSOSIALISASIIBPRDANSOSIALISASIGOLDENRULES","P5MSOSIALISASIIBPRDANSOSIALISASIGOLDENRULES","SOSIALISASIGOLDENRULES","SOSIALISASIIBPR"]);
 const ranges:string[]=[]; const meta:{sheet:keyof typeof SHEET_COLUMNS;column:string}[]=[];
 for(const sheet of Object.keys(SHEET_COLUMNS) as (keyof typeof SHEET_COLUMNS)[]) for(const column of SHEET_COLUMNS[sheet]) {ranges.push(`'${sheet}'!${column}:${column}`);meta.push({sheet,column});}
 logGoogleSheetStage("sheets_api_read_started",started,{ranges:ranges.length});
 const values=await getGoogleSheetValuesBatch(fileId,ranges);
 logGoogleSheetStage("sheets_api_read_completed",started,{ranges:ranges.length,returnedRanges:values.length});
 const data=new Map<string,Map<string,unknown[]>>();
 for(let i=0;i<meta.length;i++){const m=meta[i];const cols=data.get(m.sheet)??new Map<string,unknown[]>();cols.set(m.column,values[i]??[]);data.set(m.sheet,cols);}
 for(const sheet of Object.keys(SHEET_COLUMNS) as (keyof typeof SHEET_COLUMNS)[]){const cols=data.get(sheet);if(!cols)continue;const maxRows=Math.max(0,...Array.from(cols.values(),v=>v.length));let accepted=0;
  for(let ri=1;ri<maxRows;ri++){const row:unknown[]=[];for(const col of SHEET_COLUMNS[sheet])row[COLUMN_INDEX[col]]=cols.get(col)?.[ri]??"";
   if(sheet==="Attendance"){if(!isMinergoCompany(row[11]))continue;const nik=text(row[6]),eventDate=getGoogleAttendanceEventDate(row[1]),eventType=text(row[3]),week=text(row[16]),month=number(row[17]);if(!nik||!eventDate||!week||!Number.isInteger(month)||month<1||month>12||!allowedEvents.has(normalizeEvent(eventType)))continue;attendanceEntries.push({nik,eventDate,eventType,week,month,year:Number(eventDate.slice(0,4))});accepted++;continue;}
   let entry:ParsedGoogleEntry|undefined;
   if(sheet==="Hazard"){if(!isMinergoCompany(row[6]))continue;const nik=text(row[2]),sourceId=text(row[0]),week=text(row[31]);if(!nik||!sourceId||!week)continue;entry={sourceId:`haz_${sourceId}`,type:"hazard",nik,week,month:number(row[32]),year:excelDateToYear(row[22])};if(text(row[15]).toUpperCase()==="TTA"){await onEntry?.({...entry,sourceId:`tta_${sourceId}`,type:"tta"});entries++;}}
   else if(sheet==="Inspeksi"){if(!isMinergoCompany(row[4]))continue;const nik=text(row[2]),sourceId=text(row[6]),week=text(row[22]);if(!nik||!sourceId||!week)continue;entry={sourceId:`ins_${sourceId}`,type:"inspeksi",nik,week,month:number(row[23]),year:excelDateToYear(row[16]),timeCompliance:text(row[25])};}
   else if(sheet==="Observasi"){if(!isMinergoCompany(row[22]))continue;const nik=text(row[18]),sourceId=text(row[0]),week=text(row[23]);if(!nik||!sourceId||!week)continue;entry={sourceId:`obs_${sourceId}`,type:"observasi",nik,week,month:number(row[24]),year:excelDateToYear(row[5])};}
   else if(sheet==="OPK"){if(!isMinergoCompany(row[3]))continue;const nik=text(row[2]),sourceId=text(row[0]),week=text(row[18]);if(!nik||!sourceId||!week||number(row[17])!==1)continue;const subType=normalizeOPKSubType(row[15]);if(!subType)continue;entry={sourceId:`opk_${sourceId}`,type:"opk",subType,nik,week,month:number(row[19]),year:excelDateToYear(row[16])};}
   if(entry){await onEntry?.(entry);entries++;rowsProcessed++;accepted++;}
  }
  sheetsProcessed.push(sheet);logGoogleSheetStage("worksheet_completed",started,{sheet,rowsRead:Math.max(0,maxRows-1),rowsAccepted:accepted});
 }
 logGoogleSheetStage("parser_completed",started,{sheetsProcessed,entries,attendanceEntries:attendanceEntries.length,rowsProcessed});return {rowsProcessed,entries,attendanceEntries,sheetsProcessed};
}
