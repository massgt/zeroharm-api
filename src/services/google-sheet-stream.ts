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
export async function parseGoogleDriveXlsx(fileId:string,onEntry?:(entry:ParsedGoogleEntry)=>Promise<void>|void):Promise<{rowsProcessed:number;entries:number;attendanceEntries:ParsedGoogleAttendanceEntry[];sheetsProcessed:string[]}>{
 const started=performance.now(),drive=await import("./google-drive.js"),file=await drive.getGoogleDriveFile(fileId);
 logGoogleSheetStage("drive_metadata_completed",started,{mimeType:file.mimeType,fileSizeBytes:file.size?Number(file.size):null});
 const native="application/vnd.google-apps.spreadsheet",office=new Set(["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","application/vnd.ms-excel"]);
 let spreadsheetId=fileId,tempId:string|undefined;
 if(office.has(file.mimeType)){logGoogleSheetStage("office_conversion_started",started,{fileSizeBytes:file.size?Number(file.size):null});tempId=await drive.convertExcelToTemporaryGoogleSheet(fileId);spreadsheetId=tempId;logGoogleSheetStage("office_conversion_completed",started,{temporarySpreadsheetCreated:true});}
 else if(file.mimeType!==native)throw new Error("Format file tidak didukung. Gunakan Google Spreadsheet atau Excel .xlsx.");
 const totals={rowsProcessed:0,entries:0,attendanceEntries:[] as ParsedGoogleAttendanceEntry[],sheetsProcessed:[] as string[]};
 try{
  for(const sheet of Object.keys(SHEET_COLUMNS) as (keyof typeof SHEET_COLUMNS)[]){
   const columns=SHEET_COLUMNS[sheet],ranges=columns.map(col=>"'"+sheet+"'!"+col+":"+col),values=await getGoogleSheetValuesBatch(spreadsheetId,ranges);
   const byColumn=new Map<string,unknown[]>();for(let i=0;i<columns.length;i++)byColumn.set(columns[i],values[i]??[]);
   const data=new Map<string,Map<string,unknown[]>>();data.set(sheet,byColumn);
   const result=await parseSelectedColumns(data,onEntry);
   totals.rowsProcessed+=result.rowsProcessed;totals.entries+=result.entries;totals.attendanceEntries.push(...result.attendanceEntries);totals.sheetsProcessed.push(...result.sheetsProcessed);
   logGoogleSheetStage("worksheet_released",started,{sheet,attendanceRows:result.attendanceEntries.length,parsedEntries:result.entries});
  }
  logGoogleSheetStage("parser_completed",started,totals);return totals;
 }finally{
  if(tempId){try{await drive.deleteGoogleDriveFile(tempId);logGoogleSheetStage("temporary_spreadsheet_deleted",started);}catch(error){console.error(JSON.stringify({scope:"google_sheet_parser",stage:"temporary_spreadsheet_cleanup_failed",message:error instanceof Error?error.message:String(error)}));}}
 }
}
