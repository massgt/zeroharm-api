import { Router, type IRouter } from "express";
import multer from "multer";
import ExcelJS from "exceljs";
import fs from "node:fs/promises";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
	db,
	teamMembersTable,
	attendanceRecordsTable,
	excelUploadsTable,
} from "../db/index.js";
import { requireAdmin } from "./auth.js";

const router: IRouter = Router();

router.use((req, res, next) => {
	if (req.method === "GET" || req.method === "HEAD") {
		next();
		return;
	}
	requireAdmin(req, res, next);
});

const upload = multer({
	dest: "/tmp",
	limits: {
		fileSize: 200 * 1024 * 1024,
	},
});

const EVENT_TYPES = new Set([
	"Sosialisasi IBPR",
	"Sosialisasi Golden Rules",
	"P5M, Sosialisasi IBPR, dan Sosialisasi Golden Rules",
	"Safety Talk, Sosialisasi IBPR, dan Sosialisasi Golden Rules",
]);

const COMPANY = "PT. Minergo Visi Maxima";

function normalizeCompanyName(value: unknown): string {
	return String(value ?? "")
		.toUpperCase()
		.replace(/[^A-Z0-9]/g, "");
}

function isMinergoCompany(value: unknown): boolean {
	return normalizeCompanyName(value) === normalizeCompanyName(COMPANY);
}

function getCellValue(value: ExcelJS.CellValue): string {
	if (value === null || value === undefined) return "";

	if (value instanceof Date) {
		return value.toISOString().slice(0, 10);
	}

	if (typeof value === "object") {
		if ("text" in value) return String(value.text);
		if ("result" in value) return String(value.result ?? "");
	}

	return String(value).trim();
}

function getEventDate(value: ExcelJS.CellValue): string | null {
	if (value instanceof Date) {
		return value.toISOString().slice(0, 10);
	}

	const raw = getCellValue(value);
	if (!raw) return null;

	const date = new Date(raw);

	if (Number.isNaN(date.getTime())) return null;

	return date.toISOString().slice(0, 10);
}

router.post(
	"/preview",
	upload.single("file"),
	async (req, res): Promise<void> => {
		try {
			if (!req.file) {
				res.status(400).json({
					error: "File Excel belum dipilih.",
				});
				return;
			}

			const workbook = new ExcelJS.stream.xlsx.WorkbookReader(req.file.path, {
				entries: "ignore",
				sharedStrings: "cache",
				styles: "ignore",
				hyperlinks: "ignore",
				worksheets: "emit",
			});

			let attendanceFound = false;
			let rowsProcessed = 0;
			let rowsSkipped = 0;

			const events: Array<{
				nik: string;
				eventDate: string;
				eventType: string;
				week: string;
				month: number;
				year: number;
				ibpr: boolean;
				gr: boolean;
			}> = [];

			let worksheetIndex = 0;

			for await (const worksheet of workbook) {
				const sheetName = (
					worksheet as typeof worksheet & {
						name: string;
					}
				).name;

				if (sheetName !== "Attendance") continue;

				attendanceFound = true;

				let isHeader = true;

				for await (const row of worksheet) {
					if (isHeader) {
						isHeader = false;
						continue;
					}

					const eventDate = getEventDate(row.getCell(2).value);
					const eventType = getCellValue(row.getCell(4).value);
					const nik = getCellValue(row.getCell(7).value);
					const company = getCellValue(row.getCell(12).value);
					const week = getCellValue(row.getCell(17).value);
					const month = Number(getCellValue(row.getCell(18).value));

					if (!nik || !eventDate || !eventType || !week || !month) {
						rowsSkipped++;
						continue;
					}

					rowsProcessed++;

					if (!EVENT_TYPES.has(eventType)) continue;

					// Hanya memproses peserta dari PT Minergo Visi Maxima
					if (!isMinergoCompany(company)) continue;

					const year = Number(eventDate.slice(0, 4));

					events.push({
						nik,
						eventDate,
						eventType,
						week,
						month,
						year,
						ibpr: eventType !== "Sosialisasi Golden Rules",
						gr: eventType !== "Sosialisasi IBPR",
					});
				}
			}

			if (!attendanceFound) {
				res.status(400).json({
					error: "Sheet Attendance tidak ditemukan.",
				});
				return;
			}

			// Ringkasan klasifikasi event
			const eventTypeSummary = {
				ibprOnly: 0,
				grOnly: 0,
				both: 0,
			};

			const periodSummary = new Map<
				string,
				{
					year: number;
					month: number;
					totalEvents: number;
					uniqueNiks: Set<string>;
					ibprEvents: number;
					grEvents: number;
				}
			>();

			const uniqueNiks = new Set<string>();

			for (const event of events) {
				uniqueNiks.add(event.nik);

				if (event.eventType === "Sosialisasi IBPR") {
					eventTypeSummary.ibprOnly++;
				} else if (event.eventType === "Sosialisasi Golden Rules") {
					eventTypeSummary.grOnly++;
				} else {
					eventTypeSummary.both++;
				}

				const periodKey = `${event.year}-${String(event.month).padStart(2, "0")}`;

				if (!periodSummary.has(periodKey)) {
					periodSummary.set(periodKey, {
						year: event.year,
						month: event.month,
						totalEvents: 0,
						uniqueNiks: new Set<string>(),
						ibprEvents: 0,
						grEvents: 0,
					});
				}

				const period = periodSummary.get(periodKey)!;

				period.totalEvents++;
				period.uniqueNiks.add(event.nik);

				if (event.ibpr) period.ibprEvents++;
				if (event.gr) period.grEvents++;
			}

			const periodSummaryResult = Array.from(periodSummary.values())
				.sort((a, b) => a.year - b.year || a.month - b.month)
				.map((period) => ({
					year: period.year,
					month: period.month,
					totalEvents: period.totalEvents,
					uniqueNiks: period.uniqueNiks.size,
					ibprEvents: period.ibprEvents,
					grEvents: period.grEvents,
				}));

			// Validasi NIK terhadap master karyawan
			const nikList = [...uniqueNiks];

			const memberMap = new Map<
				string,
				{
					isActive: boolean;
					isOnLeave: boolean;
				}
			>();

			// Query bertahap maksimal 1.000 NIK
			for (let i = 0; i < nikList.length; i += 1000) {
				const nikBatch = nikList.slice(i, i + 1000);

				const members = await db
					.select({
						nik: teamMembersTable.nik,
						isActive: teamMembersTable.isActive,
						isOnLeave: teamMembersTable.isOnLeave,
					})
					.from(teamMembersTable)
					.where(inArray(teamMembersTable.nik, nikBatch));

				for (const member of members) {
					memberMap.set(member.nik, {
						isActive: member.isActive,
						isOnLeave: member.isOnLeave,
					});
				}
			}

			let nikOnsite = 0;
			let nikCuti = 0;
			let nikTidakAktif = 0;
			let nikTidakDitemukan = 0;

			for (const nik of nikList) {
				const member = memberMap.get(nik);

				if (!member) {
					nikTidakDitemukan++;
				} else if (!member.isActive) {
					nikTidakAktif++;
				} else if (member.isOnLeave) {
					nikCuti++;
				} else {
					nikOnsite++;
				}
			}

			const validationSummary = {
				totalNiksExcel: nikList.length,
				terdaftar: memberMap.size,
				tidakDitemukan: nikTidakDitemukan,
				onsite: nikOnsite,
				cuti: nikCuti,
				tidakAktif: nikTidakAktif,
			};

			// Filter event khusus karyawan Minergo
			const minergoEvents = events.filter((event) => memberMap.has(event.nik));

			const minergoUniqueNiks = new Set(
				minergoEvents.map((event) => event.nik),
			);

			// Ringkasan event khusus Minergo
			const minergoPeriodSummary = new Map<
				string,
				{
					year: number;
					month: number;
					totalEvents: number;
					uniqueNiks: Set<string>;
					ibprEvents: number;
					grEvents: number;
				}
			>();

			for (const event of minergoEvents) {
				const periodKey = `${event.year}-${String(event.month).padStart(2, "0")}`;

				if (!minergoPeriodSummary.has(periodKey)) {
					minergoPeriodSummary.set(periodKey, {
						year: event.year,
						month: event.month,
						totalEvents: 0,
						uniqueNiks: new Set<string>(),
						ibprEvents: 0,
						grEvents: 0,
					});
				}

				const period = minergoPeriodSummary.get(periodKey)!;

				period.totalEvents++;
				period.uniqueNiks.add(event.nik);

				if (event.ibpr) period.ibprEvents++;
				if (event.gr) period.grEvents++;
			}

			const minergoSummary = Array.from(minergoPeriodSummary.values())
				.sort((a, b) => a.year - b.year || a.month - b.month)
				.map((period) => ({
					year: period.year,
					month: period.month,
					totalEvents: period.totalEvents,
					uniqueNiks: period.uniqueNiks.size,
					ibprEvents: period.ibprEvents,
					grEvents: period.grEvents,
				}));

			// Rekap pencapaian sosialisasi per karyawan dan periode
			const employeeProgressMap = new Map<
				string,
				{
					nik: string;
					year: number;
					month: number;
					ibprCount: number;
					grCount: number;
					ibprDates: string[];
					grDates: string[];
				}
			>();

			for (const event of minergoEvents) {
				const key = `${event.nik}-${event.year}-${event.month}`;

				if (!employeeProgressMap.has(key)) {
					employeeProgressMap.set(key, {
						nik: event.nik,
						year: event.year,
						month: event.month,
						ibprCount: 0,
						grCount: 0,
						ibprDates: [],
						grDates: [],
					});
				}

				const progress = employeeProgressMap.get(key)!;

				if (event.ibpr) {
					progress.ibprCount++;
					progress.ibprDates.push(event.eventDate);
				}

				if (event.gr) {
					progress.grCount++;
					progress.grDates.push(event.eventDate);
				}
			}

			// Ambil seluruh karyawan aktif Minergo
			const activeMembers = await db
				.select({
					nik: teamMembersTable.nik,
					name: teamMembersTable.name,
					department: teamMembersTable.department,
					jabatan: teamMembersTable.jabatan,
					isOnLeave: teamMembersTable.isOnLeave,
				})
				.from(teamMembersTable)
				.where(eq(teamMembersTable.isActive, true));

			// Gabungkan seluruh karyawan aktif dengan seluruh periode
			type EmployeeProgressItem = {
				nik: string;
				name: string;
				department: (typeof activeMembers)[number]["department"];
				jabatan: (typeof activeMembers)[number]["jabatan"];
				year: number;
				month: number;
				employeeStatus: "Cuti" | "Onsite";
				eligibleForTarget: boolean;
				ibprCount: number;
				grCount: number;
				ibprDates: string[];
				grDates: string[];
				ibprProgress: number;
				grProgress: number;
				totalProgress: number;
				status: "Cuti" | "Complete" | "Partial" | "Belum";
			};

			const employeeProgress: EmployeeProgressItem[] = [];

			for (const period of minergoSummary) {
				for (const member of activeMembers) {
					const key = `${member.nik}-${period.year}-${period.month}`;

					const progress = employeeProgressMap.get(key);

					const ibprCount = progress?.ibprCount ?? 0;
					const grCount = progress?.grCount ?? 0;

					const ibprProgress = ibprCount > 0 ? 100 : 0;
					const grProgress = grCount > 0 ? 100 : 0;

					employeeProgress.push({
						nik: member.nik,
						name: member.name,
						department: member.department,
						jabatan: member.jabatan,

						year: period.year,
						month: period.month,

						employeeStatus: member.isOnLeave ? "Cuti" : "Onsite",
						eligibleForTarget: !member.isOnLeave,

						ibprCount,
						grCount,

						ibprDates: progress?.ibprDates ?? [],
						grDates: progress?.grDates ?? [],

						ibprProgress,
						grProgress,

						totalProgress: (ibprProgress + grProgress) / 2,

						status: member.isOnLeave
							? "Cuti"
							: ibprCount > 0 && grCount > 0
								? "Complete"
								: ibprCount > 0 || grCount > 0
									? "Partial"
									: "Belum",
					});
				}
			}

			employeeProgress.sort(
				(a, b) =>
					a.year - b.year || a.month - b.month || a.name.localeCompare(b.name),
			);

			const teamSummary = minergoSummary.map((period) => {
				const periodEmployees = employeeProgress.filter(
					(employee) =>
						employee.year === period.year && employee.month === period.month,
				);

				const eligible = periodEmployees.filter(
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

				const ibprComplete = eligible.filter(
					(employee) => employee.ibprProgress >= 100,
				).length;

				const grComplete = eligible.filter(
					(employee) => employee.grProgress >= 100,
				).length;

				const achievement = (value: number) =>
					eligible.length
						? Math.round((value / eligible.length) * 10000) / 100
						: 0;

				return {
					year: period.year,
					month: period.month,
					totalActive: periodEmployees.length,
					eligibleEmployees: eligible.length,
					excludedOnLeave: periodEmployees.length - eligible.length,
					complete,
					partial,
					belum,
					ibprComplete,
					grComplete,
					ibprAchievement: achievement(ibprComplete),
					grAchievement: achievement(grComplete),
					overallAchievement: achievement(complete),
				};
			});

			res.json({
				success: true,
				sheetName: "Attendance",
				filename: req.file.originalname,
				rowsProcessed,
				rowsSkipped,
				relevantEvents: events.length,
				uniqueNiks: uniqueNiks.size,
				validationSummary,
				minergoSummary,
				employeeProgress,
				eventTypeSummary,
				teamSummary,
				periodSummary: periodSummaryResult,
				weeksFound: [...new Set(events.map((event) => event.week))].sort(),
				sample: events.slice(0, 10),
				minergoSample: minergoEvents.slice(0, 10),
			});
		} catch (error) {
			req.log.error({ err: error }, "Attendance preview failed");

			res.status(500).json({
				error: "Gagal membaca sheet Attendance.",
			});
		} finally {
			if (req.file?.path) {
				await fs.unlink(req.file.path).catch(() => {});
			}
		}
	},
);

// GET /api/sosialisasi/periods
// Mengambil daftar periode yang tersedia
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

		res.json({
			success: true,
			periods,
		});
	} catch (error) {
		req.log.error({ err: error }, "Failed to fetch sosialisasi periods");

		res.status(500).json({
			error: "Gagal mengambil daftar periode sosialisasi.",
		});
	}
});

// GET /api/sosialisasi/dashboard?year=2026&month=10
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
				res.status(400).json({
					error: "Parameter periode tidak valid.",
				});
				return;
			}
		}

		const [lastUpdate] = await db
			.select({
				uploadedAt: excelUploadsTable.uploadedAt,
				filename: excelUploadsTable.filename,
				sourceType: excelUploadsTable.sourceType,
			})
			.from(attendanceRecordsTable)
			.innerJoin(
				excelUploadsTable,
				eq(attendanceRecordsTable.uploadId, excelUploadsTable.id),
			)
			.orderBy(desc(excelUploadsTable.uploadedAt))
			.limit(1);

		// Ambil seluruh event pada periode terpilih
		const attendance = await db
			.select({
				nik: attendanceRecordsTable.nik,
				eventDate: attendanceRecordsTable.eventDate,
				eventType: attendanceRecordsTable.eventType,
				week: attendanceRecordsTable.week,
			})
			.from(attendanceRecordsTable)
			.where(
				and(
					eq(attendanceRecordsTable.year, year),
					eq(attendanceRecordsTable.month, month),
				),
			)
			.orderBy(attendanceRecordsTable.eventDate);

		// Ambil seluruh karyawan aktif
		const members = await db
			.select({
				nik: teamMembersTable.nik,
				name: teamMembersTable.name,
				department: teamMembersTable.department,
				jabatan: teamMembersTable.jabatan,
				isOnLeave: teamMembersTable.isOnLeave,
			})
			.from(teamMembersTable)
			.where(eq(teamMembersTable.isActive, true));

		// Rekap event per NIK
		const progressMap = new Map<
			string,
			{
				ibprCount: number;
				grCount: number;
				ibprDates: Set<string>;
				grDates: Set<string>;
				weeks: Set<string>;
			}
		>();

		for (const event of attendance) {
			if (!progressMap.has(event.nik)) {
				progressMap.set(event.nik, {
					ibprCount: 0,
					grCount: 0,
					ibprDates: new Set(),
					grDates: new Set(),
					weeks: new Set(),
				});
			}

			const progress = progressMap.get(event.nik)!;

			const isIBPR = event.eventType !== "Sosialisasi Golden Rules";
			const isGR = event.eventType !== "Sosialisasi IBPR";

			if (isIBPR) {
				progress.ibprCount++;
				progress.ibprDates.add(event.eventDate);
			}

			if (isGR) {
				progress.grCount++;
				progress.grDates.add(event.eventDate);
			}

			progress.weeks.add(event.week);
		}

		// Gabungkan master karyawan dengan pencapaian
		const employees = members
			.map((member) => {
				const progress = progressMap.get(member.nik);

				const ibprCount = progress?.ibprCount ?? 0;
				const grCount = progress?.grCount ?? 0;

				const ibprProgress = ibprCount > 0 ? 100 : 0;
				const grProgress = grCount > 0 ? 100 : 0;

				const status = member.isOnLeave
					? "Cuti"
					: ibprCount > 0 && grCount > 0
						? "Complete"
						: ibprCount > 0 || grCount > 0
							? "Partial"
							: "Belum";

				return {
					nik: member.nik,
					name: member.name,
					department: member.department,
					jabatan: member.jabatan,

					employeeStatus: member.isOnLeave ? "Cuti" : "Onsite",
					eligibleForTarget: !member.isOnLeave,

					ibprCount,
					grCount,

					ibprDates: [...(progress?.ibprDates ?? [])].sort(),
					grDates: [...(progress?.grDates ?? [])].sort(),
					weeks: [...(progress?.weeks ?? [])].sort(),

					ibprProgress,
					grProgress,
					totalProgress: (ibprProgress + grProgress) / 2,

					status,
				};
			})
			.sort((a, b) => a.name.localeCompare(b.name));

		// Hitung pencapaian tim
		const eligible = employees.filter((employee) => employee.eligibleForTarget);

		const complete = eligible.filter(
			(employee) => employee.status === "Complete",
		).length;

		const partial = eligible.filter(
			(employee) => employee.status === "Partial",
		).length;

		const belum = eligible.filter(
			(employee) => employee.status === "Belum",
		).length;

		const ibprComplete = eligible.filter(
			(employee) => employee.ibprProgress === 100,
		).length;

		const grComplete = eligible.filter(
			(employee) => employee.grProgress === 100,
		).length;

		const achievement = (value: number) =>
			eligible.length ? Math.round((value / eligible.length) * 10000) / 100 : 0;

		const summary = {
			totalActive: employees.length,
			eligibleEmployees: eligible.length,
			excludedOnLeave: employees.length - eligible.length,

			complete,
			partial,
			belum,

			ibprComplete,
			grComplete,

			ibprAchievement: achievement(ibprComplete),
			grAchievement: achievement(grComplete),
			overallAchievement: achievement(complete),

			totalEvents: attendance.length,
			uniqueNiks: new Set(attendance.map((event) => event.nik)).size,

			ibprEvents: attendance.filter(
				(event) => event.eventType !== "Sosialisasi Golden Rules",
			).length,

			grEvents: attendance.filter(
				(event) => event.eventType !== "Sosialisasi IBPR",
			).length,
		};

		const period = {
			year,
			month,
		};

		res.json({
			success: true,
			period,
			lastUpdate: lastUpdate
				? {
						uploadedAt: lastUpdate.uploadedAt.toISOString(),
						filename: lastUpdate.filename,
						sourceType: lastUpdate.sourceType,
					}
				: null,
			summary,
			employees,
		});
	} catch (error) {
		req.log.error({ err: error }, "Failed to fetch sosialisasi dashboard");

		res.status(500).json({
			error: "Gagal mengambil data dashboard sosialisasi.",
		});
	}
});

export default router;
