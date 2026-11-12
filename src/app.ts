import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes/index.js";
import { logger } from "./lib/logger.js";
import path from "node:path";

const app: Express = express();

app.use(
	pinoHttp({
		logger,
		serializers: {
			req(req) {
				return {
					id: req.id,
					method: req.method,
					url: req.url?.split("?")[0],
				};
			},
			res(res) {
				return {
					statusCode: res.statusCode,
				};
			},
		},
	}),
);
const allowedOrigins = (process.env.FRONTEND_ORIGINS ?? "")
	.split(",")
	.map((origin) => origin.trim())
	.filter(Boolean);
app.use(cors({
	credentials: true,
	origin(origin, callback) {
		if (!origin || allowedOrigins.includes(origin)) {
			callback(null, true);
			return;
		}
		callback(new Error("Origin not allowed by CORS"));
	},
}));
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/uploads", express.static(path.resolve("uploads")));

app.use("/api", router);

export default app;
