import { google } from "googleapis";
import fs from "node:fs";

const GOOGLE_SHEETS_SCOPE =
	"https://www.googleapis.com/auth/spreadsheets.readonly";

function getGoogleCredentials() {
	const credentialsValue = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

	if (!credentialsValue) {
		throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not configured");
	}

	// Production: credential JSON disimpan langsung di environment variable.
	if (credentialsValue.trim().startsWith("{")) {
		return JSON.parse(credentialsValue);
	}

	// Local DEV: environment variable menunjuk ke file JSON.
	if (!fs.existsSync(credentialsValue)) {
		throw new Error(
			`Google Service Account credentials not found: ${credentialsValue}`,
		);
	}

	return JSON.parse(fs.readFileSync(credentialsValue, "utf8"));
}

function getSheetsClient() {
	const credentials = getGoogleCredentials();

	const auth = new google.auth.GoogleAuth({
		credentials,
		scopes: [GOOGLE_SHEETS_SCOPE],
	});

	return google.sheets({
		version: "v4",
		auth,
	});
}

export async function getGoogleSheetValues(
	spreadsheetId: string,
	range: string,
): Promise<string[][]> {
	const sheets = getSheetsClient();

	const response = await sheets.spreadsheets.values.get({
		spreadsheetId,
		range,
		majorDimension: "ROWS",
		valueRenderOption: "UNFORMATTED_VALUE",
		dateTimeRenderOption: "FORMATTED_STRING",
	});

	return (response.data.values ?? []) as string[][];
}


/** Fetch only required columns; avoids downloading/parsing the full XLSX workbook. */
export async function getGoogleSheetValuesBatch(spreadsheetId:string,ranges:string[]):Promise<unknown[][]>{
 const sheets=getSheetsClient();const response=await sheets.spreadsheets.values.batchGet({spreadsheetId,ranges,majorDimension:"COLUMNS",valueRenderOption:"UNFORMATTED_VALUE",dateTimeRenderOption:"SERIAL_NUMBER"});
 return (response.data.valueRanges??[]).map(range=>(range.values?.[0]??[]) as unknown[]);
}
