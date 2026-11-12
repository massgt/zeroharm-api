import { Router, type RequestHandler } from "express";
import {
	createHmac,
	timingSafeEqual,
} from "node:crypto";

const router = Router();
const COOKIE_NAME = "zh_admin";
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

function originAllowed(origin: string | undefined): boolean {
	if (!origin) return true;
	const allowed = (process.env.FRONTEND_ORIGINS ?? "")
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
	return allowed.includes(origin);
}

function getSecret(): string {
	const secret = process.env.AUTH_SECRET;
	if (!secret || secret.length < 32) {
		throw new Error("AUTH_SECRET must be configured with at least 32 characters.");
	}
	return secret;
}

function sign(payload: string): string {
	return createHmac("sha256", getSecret()).update(payload).digest("base64url");
}

function verifySession(token: string | undefined): boolean {
	if (!token) return false;
	const [expiresText, signature, extra] = token.split(".");
	if (!expiresText || !signature || extra !== undefined) return false;
	const expiresAt = Number(expiresText);
	if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) return false;
	const expected = Buffer.from(sign(expiresText));
	const actual = Buffer.from(signature);
	return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function isAdminRequest(req: { cookies?: Record<string, string> }): boolean {
	try {
		return verifySession(req.cookies?.[COOKIE_NAME]);
	} catch {
		return false;
	}
}

export const requireAdmin: RequestHandler = (req, res, next) => {
	try {
		if (!originAllowed(req.get("origin"))) {
			res.status(403).json({ error: "Request origin is not allowed" });
			return;
		}
		if (!verifySession(req.cookies?.[COOKIE_NAME])) {
			res.status(401).json({ error: "Admin authentication required" });
			return;
		}
		next();
	} catch (error) {
		req.log?.error({ err: error }, "Admin session verification failed");
		res.status(500).json({ error: "Authentication is not configured" });
	}
};

router.post("/auth/login", (req, res): void => {
	if (!originAllowed(req.get("origin"))) {
		res.status(403).json({ error: "Request origin is not allowed" });
		return;
	}
	const now = Date.now();
	const key = req.ip || req.socket.remoteAddress || "unknown";
	const attempts = loginAttempts.get(key);
	if (attempts && attempts.resetAt > now && attempts.count >= LOGIN_MAX_ATTEMPTS) {
		res.status(429).json({ error: "Too many login attempts. Try again later." });
		return;
	}
	if (!attempts || attempts.resetAt <= now) {
		loginAttempts.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
	} else {
		attempts.count += 1;
	}
	const configuredPassword = process.env.ADMIN_PASSWORD;
	const providedPassword = typeof req.body?.password === "string" ? req.body.password : "";
	if (!configuredPassword || !process.env.AUTH_SECRET) {
		res.status(503).json({ error: "Admin authentication is not configured" });
		return;
	}
	const expected = Buffer.from(configuredPassword);
	const actual = Buffer.from(providedPassword);
	const valid = expected.length === actual.length && timingSafeEqual(expected, actual);
	if (!valid) {
		res.status(401).json({ error: "Username or password is incorrect" });
		return;
	}
	loginAttempts.delete(key);

	const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
	const token = `${expiresAt}.${sign(String(expiresAt))}`;
	res.cookie(COOKIE_NAME, token, {
		httpOnly: true,
		secure: process.env.NODE_ENV === "production",
		sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
		maxAge: SESSION_TTL_SECONDS * 1000,
		path: "/",
	});
	res.json({ authenticated: true, role: "admin", expiresAt });
});

router.post("/auth/logout", (_req, res): void => {
	res.clearCookie(COOKIE_NAME, {
		httpOnly: true,
		secure: process.env.NODE_ENV === "production",
		sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
		path: "/",
	});
	res.json({ authenticated: false, role: "viewer" });
});

router.get("/auth/me", (req, res): void => {
	try {
		const authenticated = verifySession(req.cookies?.[COOKIE_NAME]);
		res.json({ authenticated, role: authenticated ? "admin" : "viewer" });
	} catch {
		res.status(503).json({ error: "Admin authentication is not configured" });
	}
});

export default router;
