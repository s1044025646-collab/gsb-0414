import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { link } from "./linker";
import { fail } from "./errors";
import { LinkResult } from "./types";

export const DATA_DIR = path.resolve(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "linker.db");

export interface VersionRow {
  id: number;
  base: number;
  module_hash: string;
  created_at: string;
  image_size: number;
  summary: string;
}

export class Store {
  db: DatabaseSync;

  constructor(dbPath: string = DB_PATH) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS module_sets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hash TEXT UNIQUE NOT NULL,
        modules_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        set_id INTEGER NOT NULL REFERENCES module_sets(id),
        base INTEGER NOT NULL,
        module_hash TEXT NOT NULL,
        image BLOB NOT NULL,
        summary TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(set_id, base)
      );
    `);
  }

  static hashModules(modules: unknown[]): string {
    const h = createHash("sha256");
    h.update(JSON.stringify(modules));
    return h.digest("hex");
  }

  /** 导入模块集合;内容变化产生新集合(新版本) */
  importModules(modules: unknown[]): { setId: number; hash: string; created: boolean } {
    if (!Array.isArray(modules) || modules.length === 0) fail("E_BAD_INPUT", "modules 必须是非空数组");
    const hash = Store.hashModules(modules);
    const existing = this.db
      .prepare("SELECT id FROM module_sets WHERE hash = ?")
      .get(hash) as { id: number } | undefined;
    if (existing) return { setId: existing.id, hash, created: false };
    const now = new Date().toISOString();
    const r = this.db
      .prepare("INSERT INTO module_sets (hash, modules_json, created_at) VALUES (?,?,?)")
      .run(hash, JSON.stringify(modules), now);
    return { setId: Number(r.lastInsertRowid), hash, created: true };
  }

  getModules(setId: number): unknown[] {
    const row = this.db.prepare("SELECT modules_json FROM module_sets WHERE id = ?").get(setId) as
      | { modules_json: string }
      | undefined;
    if (!row) fail("E_NOT_FOUND", `模块集合 ${setId} 不存在`);
    return JSON.parse(row.modules_json);
  }

  listSets() {
    return this.db
      .prepare("SELECT id, hash, created_at, json_array_length(modules_json) AS module_count FROM module_sets ORDER BY id")
      .all();
  }

  /** 链接并保存版本;相同集合+基址复用已有版本 */
  linkAndStore(setId: number, base: number): { versionId: number; result: LinkResult; reused: boolean } {
    const modules = this.getModules(setId);
    const hash = Store.hashModules(modules);
    const existing = this.db
      .prepare("SELECT id FROM versions WHERE set_id = ? AND base = ?")
      .get(setId, base) as { id: number } | undefined;
    if (existing) {
      const result = link(modules, base);
      return { versionId: existing.id, result, reused: true };
    }
    const result = link(modules, base);
    const summary = JSON.stringify({
      base,
      imageSize: result.image.length,
      layout: result.layout,
      symbols: result.symbols,
      patches: result.patches,
    });
    const r = this.db
      .prepare(
        "INSERT INTO versions (set_id, base, module_hash, image, summary, created_at) VALUES (?,?,?,?,?,?)"
      )
      .run(setId, base, hash, result.image, summary, new Date().toISOString());
    return { versionId: Number(r.lastInsertRowid), result, reused: false };
  }

  listVersions(): VersionRow[] {
    return this.db
      .prepare(
        "SELECT id, base, module_hash, created_at, length(image) AS image_size, summary FROM versions ORDER BY id"
      )
      .all() as unknown as VersionRow[];
  }

  getVersion(id: number): { row: VersionRow; image: Buffer; summary: any } {
    const row = this.db
      .prepare("SELECT id, base, module_hash, created_at, image, summary FROM versions WHERE id = ?")
      .get(id) as { id: number; base: number; module_hash: string; created_at: string; image: Buffer; summary: string } | undefined;
    if (!row) fail("E_NOT_FOUND", `版本 ${id} 不存在`);
    return {
      row: { ...row, image_size: row.image.length, summary: undefined as never },
      image: Buffer.from(row.image),
      summary: JSON.parse(row.summary),
    };
  }

  compare(aId: number, bId: number) {
    const a = this.getVersion(aId);
    const b = this.getVersion(bId);
    const symDiff: { name: string; a?: number; b?: number }[] = [];
    const names = new Set<string>();
    for (const s of a.summary.symbols) names.add(s.name);
    for (const s of b.summary.symbols) names.add(s.name);
    for (const n of names) {
      const sa = a.summary.symbols.find((s: any) => s.name === n);
      const sb = b.summary.symbols.find((s: any) => s.name === n);
      if (sa?.address !== sb?.address) symDiff.push({ name: n, a: sa?.address, b: sb?.address });
    }
    const size = Math.min(a.image.length, b.image.length);
    let byteDiffs = a.image.length === b.image.length ? 0 : Math.abs(a.image.length - b.image.length);
    for (let i = 0; i < size; i++) if (a.image[i] !== b.image[i]) byteDiffs++;
    return {
      a: { id: aId, base: a.row.base, imageSize: a.image.length },
      b: { id: bId, base: b.row.base, imageSize: b.image.length },
      identical: byteDiffs === 0,
      differingBytes: byteDiffs,
      symbolAddressChanges: symDiff,
    };
  }
}
