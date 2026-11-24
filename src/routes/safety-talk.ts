import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import {
	db,
	teamMembersTable,
	attendanceRecordsTable,
	attendanceUploadLinksTable,
	excelUploadsTable,
} from "../db/index.js";
import { isAdminRequest } from "./auth.js";

const router: IRouter = Router();
const TARGET_PER_MONTH = 4;
const normalizeEventType = (value: string) =>
	value.trim().replace(/\\s+/g, " ").toUpperCase();

const SAFETY_TALK_TYPES = new Set([
	"SAFETY TALK",
	"SAFETY TALK, SOSIALISASI IBPR, DAN SOSIALISASI GOLDEN RULES",
]);

// GET /api/safety-talk/periods
// Daftar periode mengikuti seluruh data Attendance, seperti Sosialisasi IBPR & GR.
router.get("/periods", async (req, res): Promise<void> => {
	try {
		const periods = await db
			.select({
				year: attendanceRecordsTable.year,
				month: attendanceRecordsTable.month,
			})
			.from(attendanceRecordsTable)
			.groupBy(attendanceRecordsTable.year, attendanceRecordsTable.month)
			.orderBy(
				desc(attendanceRecordsTable.year),
				desc(attendanceRecordsTable.month),
			);

		res.json({ success: true, periods });
	} catch (error) {
		req.log.error({ err: error }, "Failed to fetch Safety Talk periods");
		res.status(500).json({ error: "Gagal mengambil periode Safety Talk." });
	}
});

// GET /api/safety-talk/dashboard?year=2026&month=11
router.get("/dashboard", async (req, res): Promise<void> => {
	try {
		const yearParam = req.query.year;
		const monthParam = req.query.month;

		let year: number;
		let month: number;

		if (yearParam === undefined && monthParam === undefined) {
			const [latestPeriod] = await db
				.select({
					year: attendanceRecordsTable.year,
					month: attendanceRecordsTable.month,
				})
				.from(attendanceRecordsTable)
				.orderBy(
					desc(attendanceRecordsTable.year),
					desc(attendanceRecordsTable.month),
				)
				.limit(1);

			if (!latestPeriod) {
				res.json({
					success: true,
					period: null,
					targetPerMonth: TARGET_PER_MONTH,
					lastUpdate: null,
					summary: null,
					employees: [],
				});
				return;
			}

			year = latestPeriod.year;
			month = latestPeriod.month;
		} else {
			if (typeof yearParam !== "string" || typeof monthParam !== "string") {
				res.status(400).json({
					error: "Parameter year dan month harus diisi bersama.",
				});
				return;
			}

			year = Number(yearParam);
			month = Number(monthParam);

			if (
				!Number.isInteger(year) ||
				year < 2000 ||
				year > 2100 ||
				!Number.isInteger(month) ||
				month < 1 ||
				month > 12
			) {
				res.status(400).json({ error: "Parameter periode tidak valid." });
				return;
			}
		}

		const [lastUpdate] = await db
			.select({
				uploadedAt: excelUploadsTable.uploadedAt,
				filename: excelUploadsTable.filename,
				sourceType: excelUploadsTable.sourceType,
			})
			.from(attendanceUploadLinksTable)
			.innerJoin(
				attendanceRecordsTable,
				eq(attendanceUploadLinksTable.attendanceId, attendanceRecordsTable.id),
			)
			.innerJoin(
				excelUploadsTable,
				eq(attendanceUploadLinksTable.uploadId, excelUploadsTable.id),
			)
			.where(
				and(
					eq(attendanceRecordsTable.year, year),
					eq(attendanceRecordsTable.month, month),
				),
			)
			.orderBy(desc(excelUploadsTable.uploadedAt))
			.limit(1);

		// Seluruh kegiatan pada bulan terpilih; hanya dua jenis event yang dihitung.
		const attendance = await db
			.select({
				nik: attendanceRecordsTable.nik,
				eventType: attendanceRecordsTable.eventType,
			})
			.from(attendanceRecordsTable)
			.where(
				and(
					eq(attendanceRecordsTable.year, year),
					eq(attendanceRecordsTable.month, month),
				),
			);

		const members = await db
			.select({
				nik: teamMembersTable.nik,
				name: teamMembersTable.name,
				department: teamMembersTable.department,
				jabatan: teamMembersTable.jabatan,
				isOnLeave: teamMembersTable.isOnLeave,
			})
			.from(teamMembersTable)
			.where(eq(teamMembersTable.isActive, true))
			.orderBy(teamMembersTable.name);

		const countByNik = new Map<string, number>();
		const relevantAttendance = attendance.filter((event) =>
			SAFETY_TALK_TYPES.has(normalizeEventType(event.eventType)),
		);

		for (const event of relevantAttendance) {
			countByNik.set(event.nik, (countByNik.get(event.nik) ?? 0) + 1);
		}

		const employees = members.map((member) => {
			const totalCount = countByNik.get(member.nik) ?? 0;
			const totalProgress = Math.min(
				(totalCount / TARGET_PER_MONTH) * 100,
				100,
			);

			return {
				nik: member.nik,
				name: member.name,
				department: member.department,
				jabatan: member.jabatan,
				employeeStatus: member.isOnLeave ? "Cuti" : "Onsite",
				eligibleForTarget: !member.isOnLeave,
				target: TARGET_PER_MONTH,
				totalCount,
				totalProgress,
				status: member.isOnLeave
					? "Cuti"
					: totalProgress >= 100
						? "Complete"
						: totalCount > 0
							? "Partial"
							: "Belum",
			} as const;
		});

		const eligible = employees.filter(
			(employee) => employee.eligibleForTarget,
		);
		const complete = eligible.filter(
			(employee) => employee.status === "Complete",
		).length;
		const partial = eligible.filter(
			(employee) => employee.status === "Partial",
		).length;
		const belum = eligible.filter(
			(employee) => employee.status === "Belum",
		).length;
		const achievement = (value: number) =>
			eligible.length
				? Math.round((value / eligible.length) * 10000) / 100
				: 0;

		const summary = {
			totalActive: employees.length,
			eligibleEmployees: eligible.length,
			excludedOnLeave: employees.length - eligible.length,
			complete,
			partial,
			belum,
			achievement: achievement(complete),
			totalEvents: relevantAttendance.length,
			uniqueNiks: new Set(relevantAttendance.map((event) => event.nik)).size,
		};

		const commonResponse = {
			success: true,
			period: { year, month },
			targetPerMonth: TARGET_PER_MONTH,
			lastUpdate: lastUpdate
				? {
						uploadedAt: lastUpdate.uploadedAt.toISOString(),
						filename: lastUpdate.filename,
						sourceType: lastUpdate.sourceType,
					}
				: null,
			summary,
		};

		if (!isAdminRequest(req)) {
			res.json({
				...commonResponse,
				employees: employees
					.filter((employee) => employee.eligibleForTarget)
					.map(
						({
							nik: _nik,
							employeeStatus: _employeeStatus,
							eligibleForTarget: _eligibleForTarget,
							...employee
						}) => employee,
					),
			});
			return;
		}

		res.json({ ...commonResponse, employees });
	} catch (error) {
		req.log.error({ err: error }, "Failed to fetch Safety Talk dashboard");
		res.status(500).json({
			error: "Gagal mengambil dashboard Safety Talk.",
		});
	}
});

export default router;
