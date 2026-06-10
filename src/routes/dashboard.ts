import { Router, type IRouter } from "express";
import { eq, sql } from "drizzle-orm";
import { db, teamMembersTable, reportEntriesTable } from "../db";
import {
  GetDashboardQueryParams,
  GetDashboardResponse,
  ListWeeksResponse,
} from "../api-zod";

const router: IRouter = Router();

router.get("/weeks", async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      week: reportEntriesTable.week,
      year: reportEntriesTable.year,
      month: reportEntriesTable.month,
      totalEntries: sql<number>`count(*)::int`,
    })
    .from(reportEntriesTable)
    .groupBy(reportEntriesTable.week, reportEntriesTable.year, reportEntriesTable.month)
    .orderBy(reportEntriesTable.year, reportEntriesTable.month, reportEntriesTable.week);

  const weeks = rows.map((r) => ({
    week: r.week,
    year: r.year,
    label: `${r.week} / ${r.year}`,
    totalEntries: r.totalEntries,
  }));

  res.json(ListWeeksResponse.parse(weeks));
});

router.get("/dashboard", async (req, res): Promise<void> => {
  const query = GetDashboardQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  const { week } = query.data;

  const members = await db.select().from(teamMembersTable).orderBy(teamMembersTable.name);
  if (members.length === 0) {
    res.json(GetDashboardResponse.parse({ week, members: [], summary: { totalMembers: 0, fullyCompliant: 0, partiallyCompliant: 0, notReported: 0, overallPct: 0 } }));
    return;
  }

  const entries = await db
    .select({
      nik: reportEntriesTable.nik,
      type: reportEntriesTable.type,
      count: sql<number>`count(*)::int`,
    })
    .from(reportEntriesTable)
    .where(eq(reportEntriesTable.week, week))
    .groupBy(reportEntriesTable.nik, reportEntriesTable.type);

  // Build a lookup: nik -> type -> count
  const counts: Record<string, Record<string, number>> = {};
  for (const e of entries) {
    if (!counts[e.nik]) counts[e.nik] = {};
    counts[e.nik][e.type] = e.count;
  }

  let totalPct = 0;
  let fullyCompliant = 0;
  let partiallyCompliant = 0;
  let notReported = 0;
  let activeCount = 0;

  const memberProgresses = members.map((m) => {
    // Members on leave: show N/A (overallPct = -1 as sentinel), exclude from summary
    if (m.isOnLeave) {
      return {
        nik: m.nik,
        name: m.name,
        department: m.department,
        jabatan: m.jabatan,
        isPjo: m.isPjo,
        isOnLeave: true,
        hazard: { actual: 0, target: m.targetHazard, pct: 0 },
        inspeksi: { actual: 0, target: m.targetInspeksi, pct: 0 },
        observasi: { actual: 0, target: m.targetObservasi, pct: 0 },
        opk: { actual: 0, target: m.targetOpk, pct: 0 },
        overallPct: -1,
      };
    }

    const c = counts[m.nik] ?? {};

    const hazardActual = c["hazard"] ?? 0;
    const inspeksiActual = c["inspeksi"] ?? 0;
    const observasiActual = c["observasi"] ?? 0;
    const opkActual = c["opk"] ?? 0;

    const hazardPct = m.targetHazard > 0 ? Math.min(100, Math.round((hazardActual / m.targetHazard) * 100)) : 100;
    const inspeksiPct = m.targetInspeksi > 0 ? Math.min(100, Math.round((inspeksiActual / m.targetInspeksi) * 100)) : 100;
    const observasiPct = m.targetObservasi > 0 ? Math.min(100, Math.round((observasiActual / m.targetObservasi) * 100)) : 100;
    const opkPct = m.targetOpk > 0 ? Math.min(100, Math.round((opkActual / m.targetOpk) * 100)) : 100;

    // For PJO, OPK is not required (targetOpk = 0), so skip it in overall
    const categoriesWithTarget = [
      { pct: hazardPct, target: m.targetHazard },
      { pct: inspeksiPct, target: m.targetInspeksi },
      { pct: observasiPct, target: m.targetObservasi },
      ...(m.targetOpk > 0 ? [{ pct: opkPct, target: m.targetOpk }] : []),
    ];

    const overallPct = categoriesWithTarget.length > 0
      ? Math.round(categoriesWithTarget.reduce((sum, c) => sum + c.pct, 0) / categoriesWithTarget.length)
      : 100;

    totalPct += overallPct;
    activeCount++;

    const hasAnyReport = hazardActual + inspeksiActual + observasiActual + opkActual > 0;
    if (overallPct >= 100) fullyCompliant++;
    else if (hasAnyReport) partiallyCompliant++;
    else notReported++;

    return {
      nik: m.nik,
      name: m.name,
      department: m.department,
      jabatan: m.jabatan,
      isPjo: m.isPjo,
      isOnLeave: false,
      hazard: { actual: hazardActual, target: m.targetHazard, pct: hazardPct },
      inspeksi: { actual: inspeksiActual, target: m.targetInspeksi, pct: inspeksiPct },
      observasi: { actual: observasiActual, target: m.targetObservasi, pct: observasiPct },
      opk: { actual: opkActual, target: m.targetOpk, pct: opkPct },
      overallPct,
    };
  });

  const overallPct = activeCount > 0 ? Math.round(totalPct / activeCount) : 0;

  res.json(GetDashboardResponse.parse({
    week,
    members: memberProgresses,
    summary: {
      totalMembers: activeCount,
      fullyCompliant,
      partiallyCompliant,
      notReported,
      overallPct,
    },
  }));
});

export default router;
