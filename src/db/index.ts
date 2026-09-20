import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema/index.js";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
	throw new Error(
		"DATABASE_URL must be set. Did you forget to provision a database?",
	);
}

export const pool = new Pool({
	connectionString: process.env.DATABASE_URL,
});

pool.on("error", (error) => {
	console.error("PG_POOL_ERROR", {
		name: error.name,
		message: error.message,
		code: (error as NodeJS.ErrnoException).code,
		errno: (error as NodeJS.ErrnoException).errno,
	});
});

export const db = drizzle(pool, { schema });

export * from "./schema/index.js";
