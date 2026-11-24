import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import {
  db,
  teamMembersTable,
  attendanceRecordsTable,
  attendanceUploadLinksTable,
  excelUploadsTable,
} from "../db/index.js";

const router: IRouter = Router();
const TARGET_PER_MONTH = 4;
const SAFETY_TALK_TYPES = new Set([
  "SAFETY TALK",
  "Safety Talk, Sosialisasi IBPR, dan Sosialisasi Golden Rules",
]);

router.get("/periods", async (_req, res): Promise<void> => {
  try {
    const periods = await db
      .select({ year: attendanceRecordsTable.year, month: attendanceRecordsTable.month })
      .from(attendanceRecordsTable)
      .where(eq(attendanceRecordsTable.eventType, "SAFETY TALK"))
      .groupBy(attendanceRecordsTable.year, attendanceRecordsTable.month)
      .orderBy(desc(attendanceRecordsTable.year), desc(attendanceRecordsTable.month));
    // Include periods that contain the combined Safety Talk event as well.
    const combined = await db
      .select({ year: attendanceRecordsTable.year, month: attendanceRecordsTable.month })
      .from(attendanceRecordsTable)
      .where(eq(attendanceRecordsTable.eventType, "Safety Talk, Sosialisasi IBPR, dan Sosialisasi Golden Rules"))
      .groupBy(attendanceRecordsTable.year, attendanceRecordsTable.month)
      .orderBy(desc(attendanceRecordsTable.year), desc(attendanceRecordsTable.month));
    const unique = new Map<string, { year: number; month: number }>();
    for (const period of [...periods, ...combined]) unique.set(`${period.year}-${period.month}`, period);
    res.json({ success: true, periods: [...unique.values()].sort((a, b) => b.year - a.year || b.month - a.month) });
  } catch (error) {
    res.status(500).json({ error: "Gagal mengambil periode Safety Talk." });
  }
});

router.get("/dashboard", async (req, res): Promise<void> => {
  try {
    const year = Number(req.query.year);
    const month = Number(req.query.month);
    if (!Number.isInteger(year) || year < 2000 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12) {
      res.status(400).json({ error: "Parameter tahun dan bulan tidak valid." });
      return;
    }

    const attendance = await db.select({
      nik: attendanceRecordsTable.nik,
      eventDate: attendanceRecordsTable.eventDate,
      eventType: attendanceRecordsTable.eventType,
      week: attendanceRecordsTable.week,
    }).from(attendanceRecordsTable).where(and(
      eq(attendanceRecordsTable.year, year),
      eq(attendanceRecordsTable.month, month),
    )).orderBy(attendanceRecordsTable.eventDate);

    const [lastUpdate] = await db.select({
      uploadedAt: excelUploadsTable.uploadedAt,
      filename: excelUploadsTable.filename,
      sourceType: excelUploadsTable.sourceType,
    }).from(attendanceUploadLinksTable)
      .innerJoin(attendanceRecordsTable, eq(attendanceUploadLinksTable.attendanceId, attendanceRecordsTable.id))
      .innerJoin(excelUploadsTable, eq(attendanceUploadLinksTable.uploadId, excelUploadsTable.id))
      .where(and(eq(attendanceRecordsTable.year, year), eq(attendanceRecordsTable.month, month)))
      .orderBy(desc(excelUploadsTable.uploadedAt)).limit(1);

    const members = await db.select({
      nik: teamMembersTable.nik,
      name: teamMembersTable.name,
      department: teamMembersTable.department,
      jabatan: teamMembersTable.jabatan,
      isOnLeave: teamMembersTable.isOnLeave,
    }).from(teamMembersTable).where(eq(teamMembersTable.isActive, true)).orderBy(teamMembersTable.name);

    const weeks = [...new Set(attendance.filter(e => SAFETY_TALK_TYPES.has(e.eventType)).map(e => e.week))]
      .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));

    const progress = new Map<string, Map<string, { count: number; dates: string[] }>>();
    for (const event of attendance) {
      if (!SAFETY_TALK_TYPES.has(event.eventType)) continue;
      if (!progress.has(event.nik)) progress.set(event.nik, new Map());
      const byWeek = progress.get(event.nik)!;
      if (!byWeek.has(event.week)) byWeek.set(event.week, { count: 0, dates: [] });
      const item = byWeek.get(event.week)!;
      item.count += 1;
      item.dates.push(event.eventDate);
    }

    const employees = members.map(member => {
      const byWeek = progress.get(member.nik);
      const weekly = weeks.map(week => {
        const item = byWeek?.get(week);
        const count = item?.count ?? 0;
        return { week, count, dates: item?.dates ?? [], progress: Math.min(count / TARGET_PER_MONTH, 1) * 100 };
      });
      const totalCount = weekly.reduce((sum, item) => sum + item.count, 0);
      const totalProgress = Math.min(totalCount / TARGET_PER_MONTH, 1) * 100;
      return {
        ...member,
        employeeStatus: member.isOnLeave ? "Cuti" : "Onsite",
        eligibleForTarget: !member.isOnLeave,
        target: TARGET_PER_MONTH,
        weekly,
        totalCount,
        totalProgress,
        status: member.isOnLeave ? "Cuti" : totalProgress >= 100 ? "Complete" : totalCount > 0 ? "Partial" : "Belum",
      };
    });

    const eligible = employees.filter(e => e.eligibleForTarget);
    const complete = eligible.filter(e => e.totalProgress >= 100).length;
    const totalEvents = attendance.filter(e => SAFETY_TALK_TYPES.has(e.eventType)).length;
    res.json({
      success: true,
      period: { year, month },
      targetPerMonth: TARGET_PER_MONTH,
      lastUpdate: lastUpdate ? { uploadedAt: lastUpdate.uploadedAt.toISOString(), filename: lastUpdate.filename, sourceType: lastUpdate.sourceType } : null,
      summary: {
        totalActive: employees.length,
        eligibleEmployees: eligible.length,
        excludedOnLeave: employees.length - eligible.length,
        complete,
        partial: eligible.filter(e => e.status === "Partial").length,
        belum: eligible.filter(e => e.status === "Belum").length,
        achievement: eligible.length ? Math.round(complete / eligible.length * 10000) / 100 : 0,
        totalEvents,
        uniqueNiks: new Set(attendance.filter(e => SAFETY_TALK_TYPES.has(e.eventType)).map(e => e.nik)).size,
      },
      weeks,
      employees,
    });
  } catch (error) {
    req.log.error({ err: error }, "Failed to fetch Safety Talk dashboard");
    res.status(500).json({ error: "Gagal mengambil dashboard Safety Talk." });
  }
});

export default router;
