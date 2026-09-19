import { google } from "googleapis";
import fs from "node:fs";

const GOOGLE_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

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
