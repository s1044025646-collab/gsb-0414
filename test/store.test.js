const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../dist/store");

function tmpDb() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "linker-")), "t.db");
}

const modules = [
  {
    name: "a",
    text: { align: 4, bytes: "00000000" },
    relocations: [{ section: "text", offset: 0, type: "ABS32", symbol: "foo" }],
  },
  { name: "b", text: { align: 4, bytes: "90" }, symbols: [{ name: "foo", section: "text", offset: 0 }] },
];

test("导入-链接-重启后读取相同镜像", () => {
  const db = tmpDb();
  const s1 = new Store(db);
  const { setId } = s1.importModules(modules);
  const v1 = s1.linkAndStore(setId, 4096);
  s1.db.close();
  const s2 = new Store(db);
  const got = s2.getVersion(v1.versionId);
  assert.deepStrictEqual(got.image, v1.result.image);
  const v2 = s2.linkAndStore(setId, 4096);
  assert.strictEqual(v2.versionId, v1.versionId);
  assert.strictEqual(v2.reused, true);
  s2.db.close();
});

test("修改模块产生新版本", () => {
  const db = tmpDb();
  const s = new Store(db);
  const i1 = s.importModules(modules);
  const v1 = s.linkAndStore(i1.setId, 4096);
  const modified = JSON.parse(JSON.stringify(modules));
  modified[1].text.bytes = "9090";
  const i2 = s.importModules(modified);
  assert.notStrictEqual(i2.setId, i1.setId);
  const v2 = s.linkAndStore(i2.setId, 4096);
  assert.notStrictEqual(v2.versionId, v1.versionId);
  const cmp = s.compare(v1.versionId, v2.versionId);
  assert.strictEqual(cmp.identical, false);
  assert.ok(cmp.differingBytes > 0);
  s.db.close();
});

test("不同基址的版本符号地址不同", () => {
  const db = tmpDb();
  const s = new Store(db);
  const { setId } = s.importModules(modules);
  const v1 = s.linkAndStore(setId, 4096);
  const v2 = s.linkAndStore(setId, 8192);
  const cmp = s.compare(v1.versionId, v2.versionId);
  assert.strictEqual(cmp.symbolAddressChanges.length, 1);
  assert.strictEqual(cmp.symbolAddressChanges[0].b - cmp.symbolAddressChanges[0].a, 4096);
  s.db.close();
});
