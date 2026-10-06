const test = require("node:test");
const assert = require("node:assert");
const { link } = require("../dist/linker");

// 演示场景:基址 4096,甲 text 8 字节,乙 text 从 4104 开始并定义 foo
const modA = (relocs) => ({
  name: "a",
  text: { align: 4, bytes: "0000000000000000" },
  symbols: [],
  relocations: relocs,
});
const modB = {
  name: "b",
  text: { align: 4, bytes: "90c3" },
  symbols: [{ name: "foo", section: "text", offset: 0 }],
};

test("PCREL32 正向引用得到 4,ABS32 得到 4104", () => {
  const r = link(
    [
      modA([
        { section: "text", offset: 0, type: "PCREL32", symbol: "foo" },
        { section: "text", offset: 4, type: "ABS32", symbol: "foo" },
      ]),
      modB,
    ],
    4096
  );
  assert.strictEqual(r.layout[1].address, 4104);
  assert.strictEqual(r.image.readUInt32LE(0), 4);
  assert.strictEqual(r.image.readUInt32LE(4), 4104);
  assert.strictEqual(r.image.readInt32LE(0), 4);
});

test("反向相对引用为负位移(补码)", () => {
  const r = link(
    [
      modB,
      {
        name: "a",
        text: { align: 4, bytes: "00000000" },
        relocations: [{ section: "text", offset: 0, type: "PCREL32", symbol: "foo" }],
      },
    ],
    4096
  );
  // S=4096, a.text 对齐到 4100, P+4=4104, value=4096-4104=-8
  const v = r.image.readInt32LE(r.layout[1].offset);
  assert.strictEqual(v, -8);
  assert.strictEqual(r.image.readUInt32LE(r.layout[1].offset), 0xfffffff8);
});

test("非零加数参与计算", () => {
  const r = link(
    [modA([{ section: "text", offset: 0, type: "ABS32", symbol: "foo", addend: 16 }]), modB],
    4096
  );
  assert.strictEqual(r.image.readUInt32LE(0), 4104 + 16);
});

test("data 对齐产生零填充", () => {
  const r = link(
    [{ name: "a", text: { align: 1, bytes: "ff" }, data: { align: 16, bytes: "aa" } }],
    0
  );
  const data = r.layout.find((l) => l.section === "data");
  assert.strictEqual(data.offset, 16);
  assert.strictEqual(r.image.subarray(1, 16).every((b) => b === 0), true);
  assert.strictEqual(r.image[16], 0xaa);
});

test("未定义符号报错 E_UNDEF_SYMBOL", () => {
  assert.throws(
    () => link([modA([{ section: "text", offset: 0, type: "ABS32", symbol: "nope" }])], 0),
    (e) => e.code === "E_UNDEF_SYMBOL"
  );
});

test("重复定义报错 E_DUP_SYMBOL", () => {
  const b2 = { ...modB, name: "c" };
  assert.throws(() => link([modB, b2], 0), (e) => e.code === "E_DUP_SYMBOL");
});

test("槽重叠报错 E_SLOT_OVERLAP", () => {
  assert.throws(
    () =>
      link(
        [
          modA([
            { section: "text", offset: 0, type: "ABS32", symbol: "foo" },
            { section: "text", offset: 2, type: "ABS32", symbol: "foo" },
          ]),
          modB,
        ],
        0
      ),
    (e) => e.code === "E_SLOT_OVERLAP"
  );
});

test("ABS32 溢出报错 E_RELOC_RANGE", () => {
  assert.throws(
    () =>
      link(
        [modA([{ section: "text", offset: 0, type: "ABS32", symbol: "foo", addend: 0x7fffffff }]), modB],
        0xf0000000
      ),
    (e) => e.code === "E_RELOC_RANGE"
  );
});

test("未知类型/越界槽/非法对齐/越界符号均被拒绝", () => {
  assert.throws(
    () => link([modA([{ section: "text", offset: 0, type: "R_X", symbol: "x" }])], 0),
    (e) => e.code === "E_UNKNOWN_RELOC"
  );
  assert.throws(
    () => link([modA([{ section: "text", offset: 6, type: "ABS32", symbol: "x" }])], 0),
    (e) => e.code === "E_SLOT_OOB"
  );
  assert.throws(
    () => link([{ name: "a", text: { align: 3, bytes: "00" } }], 0),
    (e) => e.code === "E_ALIGN"
  );
  assert.throws(
    () =>
      link(
        [{ name: "a", text: { align: 1, bytes: "00" }, symbols: [{ name: "s", section: "text", offset: 2 }] }],
        0
      ),
    (e) => e.code === "E_SYM_OOB"
  );
});

test("符号可指向段末端", () => {
  const r = link(
    [{ name: "a", text: { align: 1, bytes: "00" }, symbols: [{ name: "end", section: "text", offset: 1 }] }],
    100
  );
  assert.strictEqual(r.symbols[0].address, 101);
});

test("失败时不产生半补丁镜像(先校验后写)", () => {
  assert.throws(
    () =>
      link(
        [
          modA([
            { section: "text", offset: 0, type: "ABS32", symbol: "foo" },
            { section: "text", offset: 4, type: "ABS32", symbol: "foo", addend: 0x7fffffff },
          ]),
          modB,
        ],
        0xf0000000
      ),
    (e) => e.code === "E_RELOC_RANGE"
  );
});

test("更换基址:相对位移不变,绝对地址改变", () => {
  const mods = () => [
    modA([
      { section: "text", offset: 0, type: "PCREL32", symbol: "foo" },
      { section: "text", offset: 4, type: "ABS32", symbol: "foo" },
    ]),
    modB,
  ];
  const r1 = link(mods(), 4096);
  const r2 = link(mods(), 8192);
  assert.strictEqual(r1.image.readInt32LE(0), r2.image.readInt32LE(0));
  assert.strictEqual(r2.image.readUInt32LE(4) - r1.image.readUInt32LE(4), 4096);
});

test("输入模块原字节保持不变", () => {
  const m = modA([{ section: "text", offset: 0, type: "ABS32", symbol: "foo" }]);
  link([m, modB], 4096);
  assert.strictEqual(m.text.bytes, "0000000000000000");
});
