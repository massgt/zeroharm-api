import { google } from "googleapis";
import fs from "node:fs";

const GOOGLE_SHEETS_SCOPE =
	"https://www.googleapis.com/auth/spreadsheets.readonly";

function getGoogleCredentials() {
	const credentialsPath =
		process.env.GOOGLE_SERVICE_ACCOUNT_JSON ??
		"./credentials/zeroharm-507213-2d45827f0d13.json";

	if (!fs.existsSync(credentialsPath)) {
		throw new Error(
			`Google Service Account credentials not found: ${credentialsPath}`,
		);
	}

	return JSON.parse(fs.readFileSync(credentialsPath, "utf8"));
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
