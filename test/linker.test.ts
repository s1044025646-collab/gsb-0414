import test from "node:test";
import assert from "node:assert/strict";
import { linkModules } from "../src/linker.js";
import { LinkError, ModuleInput } from "../src/model.js";
import { demoModules } from "../src/demo.js";

function expectError(code: string, fn: () => unknown): void {
  assert.throws(fn, (e: unknown) => e instanceof LinkError && (e as LinkError).code === code);
}

test("演示场景: base=4096, PCREL32=4, ABS32=4104", () => {
  const r = linkModules(demoModules, 4096);
  assert.equal(r.image.readUInt32LE(0), 4);
  assert.equal(r.image.readUInt32LE(4), 4104);
  const foo = r.symbols.find((s) => s.name === "foo")!;
  assert.equal(foo.address, 4104);
  // data 对齐: 甲.data 偏移 12 (大小2), 乙.data 对齐16 => 偏移16, 14-15 补零
  const dataB = r.sections.find((s) => s.module === "乙" && s.section === "data")!;
  assert.equal(dataB.offset % 16, 0);
  const gapStart = r.sections.find((s) => s.module === "甲" && s.section === "data")!;
  for (let i = gapStart.offset + gapStart.size; i < dataB.offset; i++) assert.equal(r.image[i], 0);
});

test("反向相对引用: 后面的模块引用前面模块的符号, 得到负数补码", () => {
  const mods: ModuleInput[] = [
    { name: "a", text: { bytes: "90", align: 1 }, symbols: [{ name: "target", section: "text", offset: 0 }] },
    {
      name: "b", text: { bytes: "00000000", align: 1 },
      relocations: [{ section: "text", offset: 0, type: "PCREL32", symbol: "target", addend: 0 }],
    },
  ];
  const r = linkModules(mods, 4096);
  // S=4096, P=4097, 期望 4096-(4097+4) = -5 => 0xfffffffb
  assert.equal(r.image.readInt32LE(1), -5);
  assert.equal(r.image.readUInt32LE(1), 0xfffffffb);
});

test("非零加数参与计算", () => {
  const mods: ModuleInput[] = [
    { name: "a", text: { bytes: "90", align: 1 }, symbols: [{ name: "x", section: "text", offset: 0 }] },
    {
      name: "b", text: { bytes: "00000000" + "00000000", align: 1 },
      relocations: [
        { section: "text", offset: 0, type: "ABS32", symbol: "x", addend: 16 },
        { section: "text", offset: 4, type: "PCREL32", symbol: "x", addend: -4 },
      ],
    },
  ];
  const r = linkModules(mods, 4096);
  assert.equal(r.image.readUInt32LE(1), 4096 + 16);
  // PCREL: 4096 + (-4) - (4101+4) = -13
  assert.equal(r.image.readInt32LE(5), -13);
});

test("未定义符号报错", () => {
  expectError("E_UNDEF_SYMBOL", () => linkModules([
    { name: "a", text: { bytes: "00000000", align: 1 }, relocations: [{ section: "text", offset: 0, type: "ABS32", symbol: "nope", addend: 0 }] },
  ], 0));
});

test("重复定义报错", () => {
  expectError("E_DUP_SYMBOL", () => linkModules([
    { name: "a", text: { bytes: "90", align: 1 }, symbols: [{ name: "foo", section: "text", offset: 0 }] },
    { name: "b", text: { bytes: "90", align: 1 }, symbols: [{ name: "foo", section: "text", offset: 0 }] },
  ], 0));
});

test("槽重叠报错", () => {
  expectError("E_SLOT_OVERLAP", () => linkModules([
    {
      name: "a", text: { bytes: "0000000000000000", align: 1 },
      symbols: [{ name: "x", section: "text", offset: 0 }],
      relocations: [
        { section: "text", offset: 0, type: "ABS32", symbol: "x", addend: 0 },
        { section: "text", offset: 2, type: "ABS32", symbol: "x", addend: 0 },
      ],
    },
  ], 0));
});

test("ABS32 溢出与 PCREL32 溢出", () => {
  expectError("E_RELOC_RANGE", () => linkModules([
    { name: "a", text: { bytes: "90", align: 1 }, symbols: [{ name: "x", section: "text", offset: 0 }] },
    { name: "b", text: { bytes: "00000000", align: 1 }, relocations: [{ section: "text", offset: 0, type: "ABS32", symbol: "x", addend: -1 }] },
  ], 0));
  // ABS32: S+A 超过 2^32-1
  expectError("E_RELOC_RANGE", () => linkModules([
    { name: "a", text: { bytes: "90", align: 1 }, symbols: [{ name: "x", section: "text", offset: 0 }] },
    { name: "b", text: { bytes: "00000000", align: 1 }, relocations: [{ section: "text", offset: 0, type: "ABS32", symbol: "x", addend: 0x200 }] },
  ], 0xffffff00));
  // PCREL32: 相对位移超 int32
  expectError("E_RELOC_RANGE", () => linkModules([
    { name: "a", text: { bytes: "90", align: 1 }, symbols: [{ name: "x", section: "text", offset: 0 }] },
    { name: "b", text: { bytes: "00000000", align: 1 }, relocations: [{ section: "text", offset: 0, type: "PCREL32", symbol: "x", addend: 0xffffffff }] },
  ], 0));
});

test("更换基址: 相对位移不变, 绝对地址改变", () => {
  const a = linkModules(demoModules, 4096);
  const b = linkModules(demoModules, 8192);
  assert.equal(a.image.readUInt32LE(0), b.image.readUInt32LE(0)); // PCREL 不变
  assert.notEqual(a.image.readUInt32LE(4), b.image.readUInt32LE(4)); // ABS32 改变
  assert.equal(b.image.readUInt32LE(4) - a.image.readUInt32LE(4), 4096);
});

test("符号可指向段末端但不得越界", () => {
  const ok = linkModules([
    { name: "a", text: { bytes: "90", align: 1 }, symbols: [{ name: "end", section: "text", offset: 1 }] },
  ], 0);
  assert.equal(ok.symbols[0].address, 1);
  expectError("E_SYMBOL_RANGE", () => linkModules([
    { name: "a", text: { bytes: "90", align: 1 }, symbols: [{ name: "bad", section: "text", offset: 2 }] },
  ], 0));
});

test("槽必须完整处于段内", () => {
  expectError("E_SLOT_RANGE", () => linkModules([
    {
      name: "a", text: { bytes: "909090", align: 1 },
      symbols: [{ name: "x", section: "text", offset: 0 }],
      relocations: [{ section: "text", offset: 0, type: "ABS32", symbol: "x", addend: 0 }],
    },
  ], 0));
});

test("非法对齐与未知重定位类型", () => {
  expectError("E_BAD_ALIGN", () => linkModules([
    { name: "a", text: { bytes: "90", align: 3 } },
  ], 0));
  expectError("E_UNKNOWN_RELOC", () => linkModules([
    {
      name: "a", text: { bytes: "00000000", align: 1 },
      symbols: [{ name: "x", section: "text", offset: 0 }],
      relocations: [{ section: "text", offset: 0, type: "R_X86_64_64" as never, symbol: "x", addend: 0 }],
    },
  ], 0));
});

test("镜像大小上限与地址空间上限", () => {
  expectError("E_IMAGE_TOO_LARGE", () => linkModules([
    { name: "a", text: { bytes: "00".repeat(17 * 1024 * 1024), align: 1 } },
  ], 0));
  expectError("E_BAD_BASE", () => linkModules([
    { name: "a", text: { bytes: "90", align: 1 } },
  ], 2 ** 32));
  expectError("E_ADDR_OVERFLOW", () => linkModules([
    { name: "a", text: { bytes: "9090", align: 1 } },
  ], 0xffffffff));
});

test("原槽字节不充当加数, 输入模块不被修改", () => {
  const mods: ModuleInput[] = JSON.parse(JSON.stringify([
    {
      name: "a", text: { bytes: "efbeadde", align: 1 }, // 槽内原有 0xdeadbeef
      symbols: [{ name: "x", section: "text", offset: 0 }],
      relocations: [{ section: "text", offset: 0, type: "ABS32", symbol: "x", addend: 0 }],
    },
  ]));
  const snapshot = JSON.stringify(mods);
  const r = linkModules(mods, 4096);
  assert.equal(r.image.readUInt32LE(0), 4096); // 只写 S+A, 忽略 0xdeadbeef
  assert.equal(JSON.stringify(mods), snapshot); // 输入未变
});
