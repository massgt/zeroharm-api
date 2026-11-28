import { Router, type IRouter } from "express";
import { eq, sql } from "drizzle-orm";

import {
	db,
	teamMembersTable,
	reportEntriesTable,
} from "../db/index.js";
import { isAdminRequest } from "./auth.js";
import {
	GetDashboardQueryParams,
	GetDashboardResponse,
	ListWeeksResponse,
} from "../api-zod/index.js";

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

	/*
	 * Week yang sama pada bulan berbeda tetap dianggap
	 * sebagai periode yang berbeda.
	 *
	 * Contoh:
	 * 2026-08-W36
	 * 2026-09-W36
	 *
	 * Keduanya tetap tersedia sebagai data periode masing-masing.
	 */

	const uniqueWeeks = new Map<
		string,
		{
			week: string;
			year: number;
			totalEntries: number;
		}
	>();

	for (const row of rows) {
		const key = `${row.year}-${row.month}-${row.week}`;

		if (!uniqueWeeks.has(key)) {
			uniqueWeeks.set(key, {
				week: row.week,
				year: row.year,
				totalEntries: row.totalEntries,
			});
		} else {
			const existing = uniqueWeeks.get(key)!;

			existing.totalEntries += row.totalEntries;
		}
	}

	/*
	 * Dashboard menggunakan nomor week sebagai parameter.
	 *
	 * Jika W36 terdapat pada Agustus dan September,
	 * keduanya digabung sebagai satu pilihan W36.
	 */
	const weekSummary = new Map<
		string,
		{
			week: string;
			year: number;
			totalEntries: number;
		}
	>();

	for (const row of uniqueWeeks.values()) {
		const key = `${row.week}-${row.year}`;

		if (!weekSummary.has(key)) {
			weekSummary.set(key, {
				week: row.week,
				year: row.year,
				totalEntries: row.totalEntries,
			});
		} else {
			const existing = weekSummary.get(key)!;
			existing.totalEntries += row.totalEntries;
		}
	}

	const weeks = Array.from(weekSummary.values())
		.sort((a, b) => {
			if (a.year !== b.year) {
				return a.year - b.year;
			}

			return a.week.localeCompare(b.week, undefined, {
				numeric: true,
			});
		})
		.map((r) => ({
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
		.where(eq(teamMembersTable.isSapParticipant, true))
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

	/*
	 * ACTIVE VERSION PERIODE
	 *
	 * Pilih upload terbaru untuk setiap periode tahun-bulan di PostgreSQL.
	 * Data dihitung di database agar API tidak memuat seluruh baris laporan
	 * ke memori Node.js.
	 */
	const aggregateResult = await db.execute(sql`
		WITH active_uploads AS (
			SELECT DISTINCT ON (r.year, r.month)
				r.year,
				r.month,
				r.upload_id
			FROM report_entries r
			INNER JOIN excel_uploads u ON u.id = r.upload_id
			WHERE r.week = ${week}
			ORDER BY r.year, r.month, u.uploaded_at DESC
		),
		active_entries AS (
			SELECT
				r.nik,
				r.type,
				r.sub_type,
				r.time_compliance
			FROM report_entries r
			INNER JOIN active_uploads a ON a.upload_id = r.upload_id
			WHERE r.week = ${week}
		),
		category_counts AS (
			SELECT
				nik,
				type,
				sub_type,
				count(*)::int AS actual
			FROM active_entries
			GROUP BY nik, type, sub_type
		),
		inspection_counts AS (
			SELECT
				nik,
				count(*)::int AS total,
				count(*) FILTER (WHERE time_compliance = 'Sesuai')::int AS sesuai
			FROM active_entries
			WHERE type = 'inspeksi'
			GROUP BY nik
		)
		SELECT
			'category'::text AS row_kind,
			nik,
			type,
			sub_type,
			actual,
			NULL::int AS total,
			NULL::int AS sesuai
		FROM category_counts
		UNION ALL
		SELECT
			'inspection'::text AS row_kind,
			nik,
			NULL::text AS type,
			NULL::text AS sub_type,
			NULL::int AS actual,
			total,
			sesuai
		FROM inspection_counts
		ORDER BY row_kind, nik
	`);

	type DashboardAggregateRow = {
	row_kind: "category" | "inspection";
	nik: string;
	type: string | null;
	sub_type: string | null;
	actual: number | null;
	total: number | null;
	sesuai: number | null;
};
	const aggregateRows = aggregateResult.rows as DashboardAggregateRow[];

	const counts: Record<string, Record<string, Record<string, number>>> = {};
	const inspectionTimeCounts: Record<string, { total: number; sesuai: number }> = {};

	for (const row of aggregateRows) {
		if (row.row_kind === "category") {
			if (!counts[row.nik]) counts[row.nik] = {};
			if (!counts[row.nik][row.type!]) counts[row.nik][row.type!] = {};
			const subType = row.sub_type ?? "_";
			counts[row.nik][row.type!][subType] = row.actual ?? 0;
			continue;
		}

		inspectionTimeCounts[row.nik] = {
			total: row.total ?? 0,
			sesuai: row.sesuai ?? 0,
		};
	}

	function calcInspectionTimePct(total: number, sesuai: number): number | null {
		if (total === 0) return null;

		return Math.min(100, Math.round((sesuai / total) * 100));
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

	const response = GetDashboardResponse.parse({
		week,
		members: memberProgresses,
		summary: {
			totalMembers: activeCount,
			fullyCompliant,
			partiallyCompliant,
			notReported,
			overallPct,
		},
	});

	if (!isAdminRequest(req)) {
		const viewerResponse = {
			...response,
			members: response.members
				.filter((member) => !member.isOnLeave)
				.map(({ nik: _nik, isOnLeave: _isOnLeave, ...member }) => member),
		};
		res.json(viewerResponse);
		return;
	}

	res.json(response);
});

export default router;
