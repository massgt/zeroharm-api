import { google } from "googleapis";

const CREDENTIALS_PATH =
	process.env.GOOGLE_APPLICATION_CREDENTIALS ??
	"credentials/zeroharm-507213-2d45827f0d13.json";

const auth = new google.auth.GoogleAuth({
	keyFile: CREDENTIALS_PATH,
	scopes: ["https://www.googleapis.com/auth/drive.readonly"],
});

const drive = google.drive({
	version: "v3",
	auth,
});

export interface GoogleDriveFileInfo {
	id: string;
	name: string;
	mimeType: string;
	size?: string;
}

export async function getGoogleDriveFile(
	fileId: string,
): Promise<GoogleDriveFileInfo> {
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
