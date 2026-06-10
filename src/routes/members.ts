import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, teamMembersTable } from "../db";
import {
  ListMembersResponse,
  UpsertMemberBody,
  UpsertMemberResponse,
  DeleteMemberParams,
  SetMemberLeaveParams,
  SetMemberLeaveBody,
  SetMemberLeaveResponse,
} from "../api-zod";

const router: IRouter = Router();

router.get("/members", async (_req, res): Promise<void> => {
  const members = await db.select().from(teamMembersTable).orderBy(teamMembersTable.name);
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
        targetHazard: parsed.data.targetHazard,
        targetInspeksi: parsed.data.targetInspeksi,
        targetObservasi: parsed.data.targetObservasi,
        targetOpk: parsed.data.targetOpk,
      },
    })
    .returning();

  res.json(UpsertMemberResponse.parse(member));
});

router.delete("/members/:nik", async (req, res): Promise<void> => {
  const params = DeleteMemberParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  await db.delete(teamMembersTable).where(eq(teamMembersTable.nik, params.data.nik));
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
