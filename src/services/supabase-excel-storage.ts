import { createClient } from "@supabase/supabase-js";
import fs from "node:fs/promises";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const BUCKET_NAME = "excel-uploads";

if (!supabaseUrl) {
	throw new Error("SUPABASE_URL is not configured");
}

if (!supabaseServiceRoleKey) {
	throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
	auth: {
		autoRefreshToken: false,
		persistSession: false,
	},
});

export async function uploadExcelChunk(params: {
	path: string;
	buffer: Buffer;
	contentType?: string;
}) {
	const { path, buffer, contentType } = params;

	const { error } = await supabase.storage
		.from(BUCKET_NAME)
		.upload(path, buffer, {
			contentType:
				contentType ??
				"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			upsert: false,
		});

	if (error) {
		throw new Error(
			`Failed to upload Excel chunk to Supabase Storage: ${error.message}`,
		);
	}

	return {
		path,
	};
}

export async function createExcelChunkUploadUrl(path: string) {
	const { data, error } = await supabase.storage
		.from(BUCKET_NAME)
		.createSignedUploadUrl(path, {
			upsert: false,
		});

	if (error) {
		throw new Error(
			`Failed to create signed Excel upload URL: ${error.message}`,
		);
	}

	return data;
}

export async function downloadExcelChunk(path: string): Promise<Buffer> {
	const { data, error } = await supabase.storage
		.from(BUCKET_NAME)
		.download(path);

	if (error) {
		throw new Error(
			`Failed to download Excel chunk from Supabase Storage: ${error.message}`,
		);
	}

	return Buffer.from(await data.arrayBuffer());
}

export async function appendExcelChunkToFile(params: {
	path: string;
	outputPath: string;
	truncate?: boolean;
}) {
	const { path, outputPath, truncate = false } = params;

	const buffer = await downloadExcelChunk(path);

	if (truncate) {
		await fs.writeFile(outputPath, buffer);
		return;
	}

	await fs.appendFile(outputPath, buffer);
}

export async function deleteExcelChunks(paths: string[]) {
	if (paths.length === 0) return;

	const storage = supabase.storage.from(BUCKET_NAME);

	for (let attempt = 1; attempt <= 3; attempt++) {
		const { error } = await storage.remove(paths);

		if (error) {
			if (attempt === 3) {
				throw new Error(
					`Failed to delete Excel chunks from Supabase Storage: ${error.message}`,
				);
			}

			await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
			continue;
		}

		const remainingPaths: string[] = [];

		for (const path of paths) {
			const lastSlash = path.lastIndexOf("/");
			const folder = path.slice(0, lastSlash);
			const filename = path.slice(lastSlash + 1);

			const { data, error: listError } = await storage.list(folder, {
				limit: 100,
			});

			if (listError) {
				if (attempt === 3) {
					throw new Error(
						`Failed to verify deleted Excel chunk: ${listError.message}`,
					);
				}

				remainingPaths.push(path);
				continue;
			}

			const stillExists = data.some((file) => file.name === filename);

			if (stillExists) {
				remainingPaths.push(path);
			}
		}

		if (remainingPaths.length === 0) {
			return;
		}

		paths = remainingPaths;

		if (attempt < 3) {
			await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
		}
	}

	throw new Error(
		`Failed to cleanup Excel chunks after 3 attempts: ${paths.join(", ")}`,
	);
}
