import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, teamMembersTable } from "../db/index.js";
import {
	ListMembersResponse,
	UpsertMemberBody,
	UpsertMemberResponse,
	DeleteMemberParams,
	SetMemberLeaveParams,
	SetMemberLeaveBody,
	SetMemberLeaveResponse,
	UpdateMemberParams,
	UpdateMemberBody,
	UpdateMemberResponse,
} from "../api-zod/index.js";

const router: IRouter = Router();

router.get("/members", async (_req, res): Promise<void> => {
	const members = await db
		.select()
		.from(teamMembersTable)
		.orderBy(teamMembersTable.name);
	res.json(ListMembersResponse.parse(members));
});

router.post("/members", async (req, res): Promise<void> => {
	const parsed = UpsertMemberBody.safeParse(req.body);
	if (!parsed.success) {
		res.status(400).json({ error: parsed.error.message });
		return;
	}

	const [member] = await db
		.insert(teamMembersTable)
		.values(parsed.data)
		.onConflictDoUpdate({
			target: teamMembersTable.nik,
			set: {
				name: parsed.data.name,
				department: parsed.data.department,
				jabatan: parsed.data.jabatan,
				isPjo: parsed.data.isPjo,
				isHse: parsed.data.isHse,
				targetTta: parsed.data.targetTta,
				targetHazard: parsed.data.targetHazard,
				targetInspeksi: parsed.data.targetInspeksi,
				targetObservasi: parsed.data.targetObservasi,
				targetOpkKeberadaanPengawas: parsed.data.targetOpkKeberadaanPengawas,
				targetOpkFungsiPengawas: parsed.data.targetOpkFungsiPengawas,
				targetOpkP2h: parsed.data.targetOpkP2h,
				targetOpkSeatbelt: parsed.data.targetOpkSeatbelt,
				targetOpkSimper: parsed.data.targetOpkSimper,
				targetOpkRoster: parsed.data.targetOpkRoster,
				targetOpkFatigue: parsed.data.targetOpkFatigue,
				targetOpkLototo: parsed.data.targetOpkLototo,
			},
		})
		.returning();

	res.json(UpsertMemberResponse.parse(member));
});

router.patch("/members/:nik", async (req, res): Promise<void> => {
	const params = UpdateMemberParams.safeParse(req.params);
	if (!params.success) {
		res.status(400).json({ error: params.error.message });
		return;
	}
	const body = UpdateMemberBody.safeParse(req.body);
	if (!body.success) {
		res.status(400).json({ error: body.error.message });
		return;
	}

	// Build partial update — only include defined fields
	const updateData: Partial<typeof teamMembersTable.$inferInsert> = {};
	const d = body.data;
	if (d.name !== undefined) updateData.name = d.name;
	if (d.department !== undefined) updateData.department = d.department;
	if (d.jabatan !== undefined) updateData.jabatan = d.jabatan;
	if (d.isPjo !== undefined) updateData.isPjo = d.isPjo;
	if (d.isHse !== undefined) updateData.isHse = d.isHse;
	if (d.isOnLeave !== undefined) updateData.isOnLeave = d.isOnLeave;
	if (d.targetTta !== undefined) updateData.targetTta = d.targetTta;
	if (d.targetHazard !== undefined) updateData.targetHazard = d.targetHazard;
	if (d.targetInspeksi !== undefined)
		updateData.targetInspeksi = d.targetInspeksi;
	if (d.targetObservasi !== undefined)
		updateData.targetObservasi = d.targetObservasi;
	if (d.targetOpkKeberadaanPengawas !== undefined)
		updateData.targetOpkKeberadaanPengawas = d.targetOpkKeberadaanPengawas;
	if (d.targetOpkFungsiPengawas !== undefined)
		updateData.targetOpkFungsiPengawas = d.targetOpkFungsiPengawas;
	if (d.targetOpkP2h !== undefined) updateData.targetOpkP2h = d.targetOpkP2h;
	if (d.targetOpkSeatbelt !== undefined)
		updateData.targetOpkSeatbelt = d.targetOpkSeatbelt;
	if (d.targetOpkSimper !== undefined)
		updateData.targetOpkSimper = d.targetOpkSimper;
	if (d.targetOpkRoster !== undefined)
		updateData.targetOpkRoster = d.targetOpkRoster;
	if (d.targetOpkFatigue !== undefined)
		updateData.targetOpkFatigue = d.targetOpkFatigue;
	if (d.targetOpkLototo !== undefined)
		updateData.targetOpkLototo = d.targetOpkLototo;

	if (Object.keys(updateData).length === 0) {
		res.status(400).json({ error: "No fields to update" });
		return;
	}

	const [updated] = await db
		.update(teamMembersTable)
		.set(updateData)
		.where(eq(teamMembersTable.nik, params.data.nik))
		.returning();

	if (!updated) {
		res.status(404).json({ error: "Member not found" });
		return;
	}

	res.json(UpdateMemberResponse.parse(updated));
});

router.delete("/members/:nik", async (req, res): Promise<void> => {
	const params = DeleteMemberParams.safeParse(req.params);
	if (!params.success) {
		res.status(400).json({ error: params.error.message });
		return;
	}
	await db
		.delete(teamMembersTable)
		.where(eq(teamMembersTable.nik, params.data.nik));
	res.sendStatus(204);
});

router.patch("/members/:nik/leave", async (req, res): Promise<void> => {
	const params = SetMemberLeaveParams.safeParse(req.params);
	if (!params.success) {
		res.status(400).json({ error: params.error.message });
		return;
	}
	const body = SetMemberLeaveBody.safeParse(req.body);
	if (!body.success) {
		res.status(400).json({ error: body.error.message });
		return;
	}
	const [updated] = await db
		.update(teamMembersTable)
		.set({ isOnLeave: body.data.isOnLeave })
		.where(eq(teamMembersTable.nik, params.data.nik))
		.returning();
	if (!updated) {
		res.status(404).json({ error: "Member not found" });
		return;
	}
	res.json(SetMemberLeaveResponse.parse(updated));
});

export default router;
