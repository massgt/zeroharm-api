import { Router, type IRouter } from "express";
import multer from "multer";
import * as xlsx from "xlsx";
import { db, teamMembersTable, excelUploadsTable, reportEntriesTable } from "../db";
import { sql } from "drizzle-orm";
import { ListUploadsResponse } from "../api-zod";

const router: IRouter = Router();
const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } });

const COMPANY = "PT. Minergo Visi Maxima";

function excelDateToYear(val: unknown): number {
  if (typeof val === "number") {
    // Excel date serial: days since 1900-01-01
    const d = xlsx.SSF.parse_date_code(val);
    return d?.y ?? new Date().getFullYear();
  }
  if (typeof val === "string") {
    return new Date(val).getFullYear() || new Date().getFullYear();
  }
  return new Date().getFullYear();
}

interface ParsedEntry {
  sourceId: string;
  type: "hazard" | "inspeksi" | "observasi" | "opk";
  nik: string;
  week: string;
  month: number;
  year: number;
}

function parseExcel(buffer: Buffer): { entries: ParsedEntry[]; rowsProcessed: number } {
  const wb = xlsx.read(buffer, { type: "buffer" });
  const entries: ParsedEntry[] = [];
  let rowsProcessed = 0;

  // --- HAZARD ---
  // Columns: [0]Hazard ID, [2]NIK Pelapor, [6]Perusahaan Pelapor, [22]Tanggal Laporan, [31]Week, [32]Month
  const hazardWs = wb.Sheets["Hazard"];
  if (hazardWs) {
    const rows = xlsx.utils.sheet_to_json<unknown[]>(hazardWs, { header: 1, defval: "" });
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i] as unknown[];
      const company = String(r[6] ?? "").trim();
      if (company !== COMPANY) continue;
      const nik = String(r[2] ?? "").trim();
      if (!nik) continue;
      const week = String(r[31] ?? "").trim();
      const month = Number(r[32]) || 0;
      const year = excelDateToYear(r[22]);
      const sourceId = String(r[0] ?? "").trim();
      if (!sourceId || !week) continue;
      entries.push({ sourceId: `haz_${sourceId}`, type: "hazard", nik, week, month, year });
      rowsProcessed++;
    }
  }

  // --- INSPEKSI ---
  // Columns: [2]NIK Pelaksana, [4]Perusahaan Pelaksana, [6]ID Inspeksi, [16]Tanggal Inspeksi, [22]Week, [23]Month
  const inspWs = wb.Sheets["Inspeksi"];
  if (inspWs) {
    const rows = xlsx.utils.sheet_to_json<unknown[]>(inspWs, { header: 1, defval: "" });
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i] as unknown[];
      const company = String(r[4] ?? "").trim();
      if (company !== COMPANY) continue;
      const nik = String(r[2] ?? "").trim();
      if (!nik) continue;
      const week = String(r[22] ?? "").trim();
      const month = Number(r[23]) || 0;
      const year = excelDateToYear(r[16]);
      const sourceId = String(r[6] ?? "").trim();
      if (!sourceId || !week) continue;
      entries.push({ sourceId: `ins_${sourceId}`, type: "inspeksi", nik, week, month, year });
      rowsProcessed++;
    }
  }

  // --- OBSERVASI ---
  // Columns: [0]ID Observasi, [5]Tanggal Observasi, [18]NIK Pelapor, [22]Perusahaan Pelapor, [23]Week, [24]Month
  const obsWs = wb.Sheets["Observasi"];
  if (obsWs) {
    const rows = xlsx.utils.sheet_to_json<unknown[]>(obsWs, { header: 1, defval: "" });
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i] as unknown[];
      const company = String(r[22] ?? "").trim();
      if (company !== COMPANY) continue;
      const nik = String(r[18] ?? "").trim();
      if (!nik) continue;
      const week = String(r[23] ?? "").trim();
      const month = Number(r[24]) || 0;
      const year = excelDateToYear(r[5]);
      const sourceId = String(r[0] ?? "").trim();
      if (!sourceId || !week) continue;
      entries.push({ sourceId: `obs_${sourceId}`, type: "observasi", nik, week, month, year });
      rowsProcessed++;
    }
  }

  // --- OPK ---
  // Columns: [0]ID Observasi, [2]NIK Observer, [3]Perusahaan Observer, [16]Tanggal Observasi, [18]Week, [19]Month
  const opkWs = wb.Sheets["OPK"];
  if (opkWs) {
    const rows = xlsx.utils.sheet_to_json<unknown[]>(opkWs, { header: 1, defval: "" });
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i] as unknown[];
      const company = String(r[3] ?? "").trim();
      if (company !== COMPANY) continue;
      const nik = String(r[2] ?? "").trim();
      if (!nik) continue;
      const week = String(r[18] ?? "").trim();
      const month = Number(r[19]) || 0;
      const year = excelDateToYear(r[16]);
      const sourceId = String(r[0] ?? "").trim();
      if (!sourceId || !week) continue;
      entries.push({ sourceId: `opk_${sourceId}`, type: "opk", nik, week, month, year });
      rowsProcessed++;
    }
  }

  return { entries, rowsProcessed };
}

router.post("/upload", upload.single("file"), async (req, res): Promise<void> => {
  if (!req.file) {
    res.status(400).json({ error: "No file uploaded. Use form field name: file" });
    return;
  }

  req.log.info({ filename: req.file.originalname, size: req.file.size }, "Processing Excel upload");

  const { entries, rowsProcessed } = parseExcel(req.file.buffer);

  // Deduplicate entries by sourceId+type
  const uniqueEntries = new Map<string, ParsedEntry>();
  for (const e of entries) {
    uniqueEntries.set(`${e.sourceId}|${e.type}`, e);
  }
  const deduped = Array.from(uniqueEntries.values());

  // Get distinct weeks
  const weeksSet = new Set<string>(deduped.map((e) => e.week));
  const weeksFound = Array.from(weeksSet).sort();

  // Save upload record
  const [uploadRecord] = await db
    .insert(excelUploadsTable)
    .values({
      filename: req.file.originalname,
      weeksFound,
      rowsProcessed,
    })
    .returning();

  // Upsert report entries in batches (skip conflicts = idempotent)
  const BATCH = 500;
  const toInsert = deduped.map((e) => ({
    uploadId: uploadRecord.id,
    sourceId: e.sourceId,
    type: e.type,
    nik: e.nik,
    week: e.week,
    month: e.month,
    year: e.year,
  }));

  for (let i = 0; i < toInsert.length; i += BATCH) {
    const batch = toInsert.slice(i, i + BATCH);
    await db
      .insert(reportEntriesTable)
      .values(batch)
      .onConflictDoNothing();
  }

  req.log.info({ uploadId: uploadRecord.id, minergoRows: deduped.length, weeks: weeksFound }, "Upload processed");

  res.json({
    uploadId: uploadRecord.id,
    weeksFound,
    rowsProcessed,
    minergoRows: deduped.length,
  });
});

router.get("/uploads", async (_req, res): Promise<void> => {
  const uploads = await db
    .select()
    .from(excelUploadsTable)
    .orderBy(excelUploadsTable.uploadedAt);

  res.json(ListUploadsResponse.parse(uploads.map((u) => ({
    ...u,
    uploadedAt: u.uploadedAt.toISOString(),
    weeksFound: u.weeksFound as string[],
  }))));
});

export default router;
