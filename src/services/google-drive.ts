import { google } from "googleapis";
import fs from "node:fs";

const GOOGLE_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";

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

function getDriveClient() {
	const credentials = getGoogleCredentials();

	const auth = new google.auth.GoogleAuth({
		credentials,
		scopes: [GOOGLE_DRIVE_SCOPE],
	});

	return google.drive({
		version: "v3",
		auth,
	});
}

export interface GoogleDriveFileInfo {
	id: string;
	name: string;
	mimeType: string;
	size?: string;
}

export async function getGoogleDriveFile(
	fileId: string,
): Promise<GoogleDriveFileInfo> {
	const drive = getDriveClient();

	const response = await drive.files.get({
		fileId,
		fields: "id,name,mimeType,size",
		supportsAllDrives: true,
	});

	const file = response.data;

	if (!file.id || !file.name || !file.mimeType) {
		throw new Error("Google Drive file metadata is incomplete");
	}

	return {
		id: file.id,
		name: file.name,
		mimeType: file.mimeType,
		size: file.size ?? undefined,
	};
}

export async function downloadGoogleDriveFile(
	fileId: string,
): Promise<NodeJS.ReadableStream> {
	const drive = getDriveClient();

	const response = await drive.files.get(
		{
			fileId,
			alt: "media",
			supportsAllDrives: true,
		},
		{
			responseType: "stream",
		},
	);

	return response.data;
}

export async function testGoogleDriveFile(
	fileId: string,
): Promise<GoogleDriveFileInfo> {
	return getGoogleDriveFile(fileId);
}

/**
 * Convert an existing Office spreadsheet into a temporary native Google Sheet.
 * The source file is streamed Drive-to-Drive and is never buffered in application memory.
 */
export async function convertExcelToTemporaryGoogleSheet(fileId: string): Promise<string> {
 const drive=getDriveClient();
 const source=await getGoogleDriveFile(fileId);
 const stream=await downloadGoogleDriveFile(fileId);
 const response=await drive.files.create({
  requestBody:{
   name:`zeroharm-import-tmp-${Date.now()}-${source.name.replace(/\\.(xlsx|xls)$/i,"")}`,
   mimeType:"application/vnd.google-apps.spreadsheet",
  },
  media:{mimeType:source.mimeType,body:stream as NodeJS.ReadableStream},
  fields:"id",
  supportsAllDrives:true,
 });
 if(!response.data.id) throw new Error("Google Drive gagal membuat spreadsheet sementara hasil konversi");
 return response.data.id;
}

export async function deleteGoogleDriveFile(fileId:string):Promise<void>{
 const drive=getDriveClient();
 await drive.files.delete({fileId,supportsAllDrives:true});
}
