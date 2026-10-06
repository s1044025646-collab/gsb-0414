import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { LinkError, LinkResult, ModuleInput } from "./model.js";
import { linkModules } from "./linker.js";

export interface StoredJob {
  id: number;
  setId: number;
  base: number;
  imageSize: number;
  summary: string;
  createdAt: string;
}

export class Store {
  private db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, "linker.db"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS modules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        content TEXT NOT NULL,
        hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS module_sets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS module_set_items (
        set_id INTEGER NOT NULL REFERENCES module_sets(id),
        ord INTEGER NOT NULL,
        module_id INTEGER NOT NULL REFERENCES modules(id),
        PRIMARY KEY (set_id, ord)
      );
      CREATE TABLE IF NOT EXISTS link_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        set_id INTEGER NOT NULL REFERENCES module_sets(id),
        base INTEGER NOT NULL,
        image BLOB NOT NULL,
        manifest TEXT NOT NULL,
        summary TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  close(): void { this.db.close(); }

  importModules(modules: ModuleInput[]): number {
    const insMod = this.db.prepare("INSERT INTO modules (name, content, hash) VALUES (?, ?, ?)");
    const insSet = this.db.prepare("INSERT INTO module_sets DEFAULT VALUES");
    const insItem = this.db.prepare("INSERT INTO module_set_items (set_id, ord, module_id) VALUES (?, ?, ?)");
    this.db.exec("BEGIN");
    try {
      const setId = Number(insSet.run().lastInsertRowid);
      modules.forEach((m, i) => {
        const content = JSON.stringify(m);
        const hash = createHash("sha256").update(content).digest("hex");
        const modId = Number(insMod.run(m.name, content, hash).lastInsertRowid);
        insItem.run(setId, i, modId);
      });
      this.db.exec("COMMIT");
      return setId;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  getSetModules(setId: number): ModuleInput[] {
    const rows = this.db.prepare(
      `SELECT m.content FROM module_set_items i JOIN modules m ON m.id = i.module_id
       WHERE i.set_id = ? ORDER BY i.ord`
    ).all(setId) as { content: string }[];
    if (rows.length === 0) throw new LinkError("E_NOT_FOUND", `模块集合 ${setId} 不存在或为空`);
    return rows.map((r) => JSON.parse(r.content) as ModuleInput);
  }

  listSets(): { id: number; moduleCount: number; createdAt: string }[] {
    const rows = this.db.prepare(
      `SELECT s.id, s.created_at AS createdAt, COUNT(i.ord) AS moduleCount
       FROM module_sets s LEFT JOIN module_set_items i ON i.set_id = s.id
       GROUP BY s.id ORDER BY s.id`
    ).all() as unknown as { id: number; moduleCount: number; createdAt: string }[];
    return rows;
  }

  link(setId: number, base: number): { jobId: number; result: LinkResult } {
    const modules = this.getSetModules(setId);
    const result = linkModules(modules, base);
    const manifest = JSON.stringify({
      base: result.base,
      imageSize: result.imageSize,
      sections: result.sections,
      symbols: result.symbols,
      patches: result.patches,
    });
    const summary = JSON.stringify({
      base: result.base, imageSize: result.imageSize,
      sectionCount: result.sections.length,
      symbolCount: result.symbols.length,
      patchCount: result.patches.length,
      imageSha256: createHash("sha256").update(result.image).digest("hex"),
    });
    const jobId = Number(this.db.prepare(
      "INSERT INTO link_jobs (set_id, base, image, manifest, summary) VALUES (?, ?, ?, ?, ?)"
    ).run(setId, base, result.image, manifest, summary).lastInsertRowid);
    return { jobId, result };
  }

  getJob(jobId: number): { job: StoredJob; manifest: LinkResultManifest } {
    const row = this.db.prepare("SELECT * FROM link_jobs WHERE id = ?").get(jobId) as
      | { id: number; set_id: number; base: number; image: Buffer; manifest: string; summary: string; created_at: string }
      | undefined;
    if (!row) throw new LinkError("E_NOT_FOUND", `链接任务 ${jobId} 不存在`);
    return {
      job: { id: row.id, setId: row.set_id, base: row.base, imageSize: row.image.length, summary: row.summary, createdAt: row.created_at },
      manifest: JSON.parse(row.manifest) as LinkResultManifest,
    };
  }

  getImage(jobId: number): Buffer {
    const row = this.db.prepare("SELECT image FROM link_jobs WHERE id = ?").get(jobId) as { image: Buffer } | undefined;
    if (!row) throw new LinkError("E_NOT_FOUND", `链接任务 ${jobId} 不存在`);
    return Buffer.from(row.image);
  }

  listJobs(): StoredJob[] {
    const rows = this.db.prepare("SELECT id, set_id, base, length(image) AS imageSize, summary, created_at FROM link_jobs ORDER BY id").all() as
      { id: number; set_id: number; base: number; imageSize: number; summary: string; created_at: string }[];
    return rows.map((r) => ({ id: r.id, setId: r.set_id, base: r.base, imageSize: r.imageSize, summary: r.summary, createdAt: r.created_at }));
  }
}

export interface LinkResultManifest {
  base: number;
  imageSize: number;
  sections: LinkResult["sections"];
  symbols: LinkResult["symbols"];
  patches: LinkResult["patches"];
}

export function compareJobs(a: LinkResultManifest, b: LinkResultManifest) {
  const symA = new Map(a.symbols.map((s) => [s.name, s]));
  const symB = new Map(b.symbols.map((s) => [s.name, s]));
  const symbolDiffs: object[] = [];
  for (const [name, sa] of symA) {
    const sb = symB.get(name);
    if (!sb) symbolDiffs.push({ name, change: "removed", addressA: sa.address });
    else if (sa.address !== sb.address) symbolDiffs.push({ name, change: "moved", addressA: sa.address, addressB: sb.address, delta: sb.address - sa.address });
  }
  for (const [name, sb] of symB) {
    if (!symA.has(name)) symbolDiffs.push({ name, change: "added", addressB: sb.address });
  }
  const patchDiffs: object[] = [];
  const key = (p: LinkResult["patches"][number]) => `${p.module}:${p.section}:${p.slotOffset}:${p.symbol}`;
  const pa = new Map(a.patches.map((p) => [key(p), p]));
  const pb = new Map(b.patches.map((p) => [key(p), p]));
  for (const [k, x] of pa) {
    const y = pb.get(k);
    if (!y) patchDiffs.push({ patch: k, change: "removed" });
    else if (x.value !== y.value) patchDiffs.push({ patch: k, change: "value", valueA: x.value, valueB: y.value });
  }
  for (const k of pb.keys()) if (!pa.has(k)) patchDiffs.push({ patch: k, change: "added" });
  return {
    baseA: a.base, baseB: b.base,
    imageSizeA: a.imageSize, imageSizeB: b.imageSize,
    symbolDiffs, patchDiffs,
  };
}
