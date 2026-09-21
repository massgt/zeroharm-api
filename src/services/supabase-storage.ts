import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const BUCKET_NAME = "safety-campaigns";

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

export async function uploadSafetyCampaignImage(params: {
	path: string;
	buffer: Buffer;
	contentType: string;
}) {
	const { path, buffer, contentType } = params;

	const { error } = await supabase.storage
		.from(BUCKET_NAME)
		.upload(path, buffer, {
			contentType,
			upsert: false,
		});

	if (error) {
		throw new Error(
			`Failed to upload image to Supabase Storage: ${error.message}`,
		);
	}

	const { data } = supabase.storage.from(BUCKET_NAME).getPublicUrl(path);

	return {
		path,
		publicUrl: data.publicUrl,
	};
}

export async function deleteSafetyCampaignImage(path: string) {
	const { error } = await supabase.storage.from(BUCKET_NAME).remove([path]);

	if (error) {
		throw new Error(
			`Failed to delete image from Supabase Storage: ${error.message}`,
		);
	}
}
