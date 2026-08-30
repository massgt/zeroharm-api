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
		.groupBy(
			reportEntriesTable.week,
			reportEntriesTable.year,
			reportEntriesTable.month,
		)
		.orderBy(
			reportEntriesTable.year,
			reportEntriesTable.month,
			reportEntriesTable.week,
		);

	const weeks = rows.map((r) => ({
		week: r.week,
		year: r.year,
		label: `${r.week} / ${r.year}`,
		totalEntries: r.totalEntries,
	}));

	res.json(ListWeeksResponse.parse(weeks));
});

function calcPct(actual: number, target: number): number {
	if (target === 0) return 100;
	return Math.min(100, Math.round((actual / target) * 100));
}

function makeItem(actual: number, target: number) {
	return { actual, target, pct: calcPct(actual, target) };
}

router.get("/dashboard", async (req, res): Promise<void> => {
	const query = GetDashboardQueryParams.safeParse(req.query);
	if (!query.success) {
		res.status(400).json({ error: query.error.message });
		return;
	}
	const { week } = query.data;

	const members = await db
		.select()
		.from(teamMembersTable)
		.orderBy(teamMembersTable.name);
	if (members.length === 0) {
		res.json(
			GetDashboardResponse.parse({
				week,
				members: [],
				summary: {
					totalMembers: 0,
					fullyCompliant: 0,
					partiallyCompliant: 0,
					notReported: 0,
					overallPct: 0,
				},
			}),
		);
		return;
	}

	const entries = await db
		.select({
			nik: reportEntriesTable.nik,
			type: reportEntriesTable.type,
			subType: reportEntriesTable.subType,
			count: sql<number>`count(*)::int`,
		})
		.from(reportEntriesTable)
		.where(eq(reportEntriesTable.week, week))
		.groupBy(
			reportEntriesTable.nik,
			reportEntriesTable.type,
			reportEntriesTable.subType,
		);

	const inspectionTimeRows = await db
		.select({
			nik: reportEntriesTable.nik,
			total: sql<number>`count(*)::int`,
			sesuai: sql<number>`
      count(*) FILTER (
        WHERE ${reportEntriesTable.timeCompliance} = 'Sesuai'
      )::int
    `,
		})
		.from(reportEntriesTable)
		.where(
			sql`
      ${reportEntriesTable.week} = ${week}
      AND ${reportEntriesTable.type} = 'inspeksi'
    `,
		)
		.groupBy(reportEntriesTable.nik);

	const inspectionTimeCounts: Record<
		string,
		{
			total: number;
			sesuai: number;
		}
	> = {};

	for (const row of inspectionTimeRows) {
		inspectionTimeCounts[row.nik] = {
			total: row.total,
			sesuai: row.sesuai,
		};
	}

	function calcInspectionTimePct(total: number, sesuai: number): number | null {
		if (total === 0) return null;

		return Math.min(100, Math.round((sesuai / total) * 100));
	}

	const counts: Record<string, Record<string, Record<string, number>>> = {};
	for (const e of entries) {
		if (!counts[e.nik]) counts[e.nik] = {};
		if (!counts[e.nik][e.type]) counts[e.nik][e.type] = {};
		counts[e.nik][e.type][e.subType ?? "_"] = e.count;
	}

	function get(nik: string, type: string, subType?: string): number {
		return counts[nik]?.[type]?.[subType ?? "_"] ?? 0;
	}
	function sumType(nik: string, type: string): number {
		const m = counts[nik]?.[type];
		if (!m) return 0;
		return Object.values(m).reduce((s, v) => s + v, 0);
	}

	let totalPct = 0,
		fullyCompliant = 0,
		partiallyCompliant = 0,
		notReported = 0,
		activeCount = 0;

	const memberProgresses = members.map((m) => {
		const inspectionTime = inspectionTimeCounts[m.nik] ?? {
			total: 0,
			sesuai: 0,
		};

		const inspectionTimePct = calcInspectionTimePct(
			inspectionTime.total,
			inspectionTime.sesuai,
		);

		const zero = { actual: 0, target: 0, pct: 0 };
		if (m.isOnLeave) {
			return {
				nik: m.nik,
				name: m.name,
				department: m.department,
				jabatan: m.jabatan,
				isPjo: m.isPjo,
				isHse: m.isHse,
				isOnLeave: true,
				tta: zero,
				hazard: zero,
				inspeksi: zero,
				observasi: zero,
				opkKeberadaanPengawas: zero,
				opkFungsiPengawas: zero,
				opkPencahayaan: zero,
				opkP2h: zero,
				opkSeatbelt: zero,
				opkSimper: zero,
				opkRoster: zero,
				opkFatigue: zero,
				opkLototo: zero,
				overallPct: -1,
				inspectionTimeCompliance: {
					total: 0,
					sesuai: 0,
					tidakSesuai: 0,
					pct: null,
				},
			};
		}

		const ttaA = sumType(m.nik, "tta");
		const hazardA = sumType(m.nik, "hazard");
		const inspeksiA = sumType(m.nik, "inspeksi");
		const observasiA = sumType(m.nik, "observasi");
		const opkKebA = get(m.nik, "opk", "keberadaan_pengawas");
		const opkFungsiA = get(m.nik, "opk", "fungsi_pengawas");
		const opkP2hA = get(m.nik, "opk", "p2h");
		const opkSeatbeltA = get(m.nik, "opk", "seatbelt");
		const opkSimperA = get(m.nik, "opk", "simper");
		const opkRosterA = get(m.nik, "opk", "roster");
		const opkFatigueA = get(m.nik, "opk", "fatigue");
		const opkLototoA = get(m.nik, "opk", "lototo");
		const opkPencahayaanA = get(m.nik, "opk", "pencahayaan");

		const categories: { actual: number; target: number }[] = [];
		if (m.targetTta > 0) categories.push({ actual: ttaA, target: m.targetTta });
		if (m.targetHazard > 0)
			categories.push({ actual: hazardA, target: m.targetHazard });
		if (m.targetInspeksi > 0)
			categories.push({ actual: inspeksiA, target: m.targetInspeksi });
		if (m.targetObservasi > 0)
			categories.push({ actual: observasiA, target: m.targetObservasi });
		if (m.isHse) {
			if (m.targetOpkKeberadaanPengawas > 0)
				categories.push({
					actual: opkKebA,
					target: m.targetOpkKeberadaanPengawas,
				});
			if (m.targetOpkFungsiPengawas > 0)
				categories.push({
					actual: opkFungsiA,
					target: m.targetOpkFungsiPengawas,
				});
			if (m.targetOpkPencahayaan > 0)
				categories.push({
					actual: opkPencahayaanA,
					target: m.targetOpkPencahayaan,
				});
		} else if (!m.isPjo) {
			if (m.targetOpkP2h > 0)
				categories.push({ actual: opkP2hA, target: m.targetOpkP2h });
			if (m.targetOpkSeatbelt > 0)
				categories.push({ actual: opkSeatbeltA, target: m.targetOpkSeatbelt });
			if (m.targetOpkSimper > 0)
				categories.push({ actual: opkSimperA, target: m.targetOpkSimper });
			if (m.targetOpkRoster > 0)
				categories.push({ actual: opkRosterA, target: m.targetOpkRoster });
			if (m.targetOpkFatigue > 0)
				categories.push({ actual: opkFatigueA, target: m.targetOpkFatigue });
			if (m.targetOpkLototo > 0)
				categories.push({ actual: opkLototoA, target: m.targetOpkLototo });
		}

		const overallPct =
			categories.length === 0
				? 100
				: Math.round(
						categories.reduce((s, c) => s + calcPct(c.actual, c.target), 0) /
							categories.length,
					);

		totalPct += overallPct;
		activeCount++;
		const totalActual = categories.reduce((s, c) => s + c.actual, 0);
		if (overallPct >= 100) fullyCompliant++;
		else if (totalActual > 0) partiallyCompliant++;
		else notReported++;

		return {
			nik: m.nik,
			name: m.name,
			department: m.department,
			jabatan: m.jabatan,
			isPjo: m.isPjo,
			isHse: m.isHse,
			isOnLeave: false,
			tta: makeItem(ttaA, m.targetTta),
			hazard: makeItem(hazardA, m.targetHazard),
			inspeksi: makeItem(inspeksiA, m.targetInspeksi),
			//Kesesuaian Wantu Inspeksi
			inspectionTimeCompliance: {
				total: inspectionTime.total,
				sesuai: inspectionTime.sesuai,
				tidakSesuai: inspectionTime.total - inspectionTime.sesuai,
				pct: inspectionTimePct,
			},
			observasi: makeItem(observasiA, m.targetObservasi),
			opkKeberadaanPengawas: makeItem(opkKebA, m.targetOpkKeberadaanPengawas),
			opkFungsiPengawas: makeItem(opkFungsiA, m.targetOpkFungsiPengawas),
			opkPencahayaan: makeItem(opkPencahayaanA, m.targetOpkPencahayaan),
			opkP2h: makeItem(opkP2hA, m.targetOpkP2h),
			opkSeatbelt: makeItem(opkSeatbeltA, m.targetOpkSeatbelt),
			opkSimper: makeItem(opkSimperA, m.targetOpkSimper),
			opkRoster: makeItem(opkRosterA, m.targetOpkRoster),
			opkFatigue: makeItem(opkFatigueA, m.targetOpkFatigue),
			opkLototo: makeItem(opkLototoA, m.targetOpkLototo),

			overallPct,
		};
	});

	const overallPct = activeCount > 0 ? Math.round(totalPct / activeCount) : 0;

	res.json(
		GetDashboardResponse.parse({
			week,
			members: memberProgresses,
			summary: {
				totalMembers: activeCount,
				fullyCompliant,
				partiallyCompliant,
				notReported,
				overallPct,
			},
		}),
	);
});

export default router;
