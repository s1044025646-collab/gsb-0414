import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { demoModules } from "../src/demo.js";
import { startServer } from "../src/server.js";

test("SQLite 持久化: 重启后可读取相同镜像", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "linker-"));
  try {
    let store = new Store(dir);
    const setId = store.importModules(demoModules);
    const { jobId, result } = store.link(setId, 4096);
    const hash1 = result.image.toString("hex");
    store.close();
    // 重新打开
    store = new Store(dir);
    const image2 = store.getImage(jobId).toString("hex");
    assert.equal(image2, hash1);
    const { manifest } = store.getJob(jobId);
    assert.equal(manifest.base, 4096);
    assert.equal(manifest.symbols.find((s) => s.name === "foo")!.address, 4104);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("HTTP API: 导入-链接-查询-比较-下载", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "linker-"));
  const store = new Store(dir);
  const { port, server } = await startServer(store, 0);
  const base = `http://127.0.0.1:${port}`;
  try {
    const post = async (p: string, body: unknown) => {
      const res = await fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return { status: res.status, json: await res.json() };
    };
    const imp = await post("/sets", { modules: demoModules });
    assert.equal(imp.status, 201);
    const setId = imp.json.setId;

    const bad = await post("/link", { setId, base: -1 });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.code, "E_BAD_BASE");

    const l1 = await post("/link", { setId, base: 4096 });
    const l2 = await post("/link", { setId, base: 8192 });
    assert.equal(l1.status, 201);

    const layout = await (await fetch(`${base}/jobs/${l1.json.jobId}/layout`)).json();
    assert.equal(layout.sections.length, 4);

    const cmp = await (await fetch(`${base}/jobs/${l1.json.jobId}/compare?with=${l2.json.jobId}`)).json();
    const fooDiff = cmp.symbolDiffs.find((d: { name: string }) => d.name === "foo");
    assert.equal(fooDiff.delta, 4096);

    const img = await fetch(`${base}/jobs/${l1.json.jobId}/image`);
    const buf = Buffer.from(await img.arrayBuffer());
    assert.equal(buf.readUInt32LE(0), 4);
    assert.equal(buf.readUInt32LE(4), 4104);

    const patches = await (await fetch(`${base}/jobs/${l1.json.jobId}/patches`)).json();
    assert.equal(patches.patches.length, 2);
    assert.equal(patches.patches[0].before, "00000000");
  } finally {
    server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
