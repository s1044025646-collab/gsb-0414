import { fail } from "./errors";
import {
  LinkResult,
  ModuleInput,
  PatchInfo,
  RelocDef,
  SectionLayout,
  SectionName,
  SymbolEntry,
} from "./types";

export const MAX_ALIGN = 4096;
export const MAX_IMAGE_SIZE = 16 * 1024 * 1024; // 16 MiB
const UINT32_MAX = 0xffffffff;

interface ParsedModule {
  name: string;
  text: Buffer;
  data: Buffer;
  textAlign: number;
  dataAlign: number;
  symbols: { name: string; section: SectionName; offset: number }[];
  relocations: Required<RelocDef>[];
}

function isPow2(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

function parseHex(hex: string, where: string): Buffer {
  if (typeof hex !== "string") fail("E_BAD_HEX", `${where}: bytes 必须是十六进制字符串`);
  const clean = hex.replace(/\s+/g, "");
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) {
    fail("E_BAD_HEX", `${where}: 非法十六进制字节串`);
  }
  return Buffer.from(clean, "hex");
}

function parseAlign(v: unknown, where: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || !isPow2(v) || v > MAX_ALIGN) {
    fail("E_ALIGN", `${where}: 对齐必须是 1..${MAX_ALIGN} 内的二次幂,收到 ${v}`);
  }
  return v;
}

export function validateModule(raw: unknown, index: number): ParsedModule {
  const where = `模块[${index}]`;
  if (typeof raw !== "object" || raw === null) fail("E_BAD_INPUT", `${where}: 必须是对象`);
  const m = raw as ModuleInput;
  if (typeof m.name !== "string" || m.name.length === 0) {
    fail("E_BAD_INPUT", `${where}: name 必须是非空字符串`);
  }
  const sec = (s: { align: number; bytes: string } | undefined, tag: string) => {
    if (s === undefined) return { buf: Buffer.alloc(0), align: 1 };
    if (typeof s !== "object" || s === null) fail("E_SECTION", `${where}.${tag}: 必须是对象`);
    return { buf: parseHex(s.bytes ?? "", `${where}.${tag}`), align: parseAlign(s.align ?? 1, `${where}.${tag}`) };
  };
  const text = sec(m.text as never, "text");
  const data = sec(m.data as never, "data");

  const symbols = (m.symbols ?? []).map((s, i) => {
    const w = `${where}.symbols[${i}]`;
    if (typeof s?.name !== "string" || s.name.length === 0) fail("E_BAD_INPUT", `${w}: name 非法`);
    if (s.section !== "text" && s.section !== "data") fail("E_SECTION", `${w}: section 必须是 text|data`);
    if (!Number.isInteger(s.offset) || s.offset < 0) fail("E_SYM_OOB", `${w}: offset 非法`);
    const size = s.section === "text" ? text.buf.length : data.buf.length;
    if (s.offset > size) fail("E_SYM_OOB", `${w}: 符号 ${s.name} 偏移 ${s.offset} 越过段末端 ${size}`);
    return { name: s.name, section: s.section, offset: s.offset };
  });

  const relocations = (m.relocations ?? []).map((r, i) => {
    const w = `${where}.relocations[${i}]`;
    if (r.section !== "text" && r.section !== "data") fail("E_SECTION", `${w}: section 必须是 text|data`);
    if (r.type !== "ABS32" && r.type !== "PCREL32") fail("E_UNKNOWN_RELOC", `${w}: 未知重定位类型 ${r.type}`);
    if (!Number.isInteger(r.offset) || r.offset < 0) fail("E_SLOT_OOB", `${w}: offset 非法`);
    const size = r.section === "text" ? text.buf.length : data.buf.length;
    if (r.offset + 4 > size) fail("E_SLOT_OOB", `${w}: 槽 [${r.offset},${r.offset + 4}) 越出段大小 ${size}`);
    const addend = r.addend ?? 0;
    if (!Number.isInteger(addend) || addend < -0x80000000 || addend > 0x7fffffff) {
      fail("E_BAD_ADDEND", `${w}: addend 必须是 int32 整数,收到 ${r.addend}`);
    }
    if (typeof r.symbol !== "string" || r.symbol.length === 0) fail("E_BAD_INPUT", `${w}: symbol 非法`);
    return { section: r.section, offset: r.offset, type: r.type, symbol: r.symbol, addend };
  });

  return {
    name: m.name,
    text: text.buf,
    data: data.buf,
    textAlign: text.align,
    dataAlign: data.align,
    symbols,
    relocations,
  };
}

function alignUp(n: number, a: number): number {
  return Math.ceil(n / a) * a;
}

export function link(rawModules: unknown[], base: number): LinkResult {
  if (!Array.isArray(rawModules) || rawModules.length === 0) {
    fail("E_BAD_INPUT", "modules 必须是非空数组");
  }
  if (!Number.isInteger(base) || base < 0 || base > UINT32_MAX) {
    fail("E_ADDR_RANGE", `基址必须是 0..${UINT32_MAX} 的整数,收到 ${base}`);
  }
  const modules = rawModules.map((m, i) => validateModule(m, i));
  const seen = new Set<string>();
  for (const m of modules) {
    if (seen.has(m.name)) fail("E_BAD_INPUT", `模块名 ${m.name} 重复`);
    seen.add(m.name);
  }

  // 布局:先全部 text,再全部 data,按输入顺序,段起点按对齐向上取整
  const layout: SectionLayout[] = [];
  let cursor = 0;
  const place = (mod: ParsedModule, section: SectionName, buf: Buffer, align: number) => {
    const offset = alignUp(cursor, align);
    layout.push({
      module: mod.name,
      section,
      align,
      size: buf.length,
      offset,
      address: base + offset,
      fileOffset: offset,
    });
    cursor = offset + buf.length;
  };
  for (const m of modules) place(m, "text", m.text, m.textAlign);
  for (const m of modules) place(m, "data", m.data, m.dataAlign);
  if (cursor > MAX_IMAGE_SIZE) fail("E_IMAGE_TOO_LARGE", `镜像大小 ${cursor} 超过上限 ${MAX_IMAGE_SIZE}`);
  if (base + cursor - 1 > UINT32_MAX) fail("E_ADDR_RANGE", `基址 ${base} + 大小 ${cursor} 超出 32 位地址范围`);

  const secOf = (modName: string, section: SectionName) =>
    layout.find((l) => l.module === modName && l.section === section)!;

  // 符号解析:强符号全局唯一
  const symtab = new Map<string, SymbolEntry>();
  for (const m of modules) {
    for (const s of m.symbols) {
      if (symtab.has(s.name)) {
        fail("E_DUP_SYMBOL", `符号 ${s.name} 重复定义(${symtab.get(s.name)!.module} 与 ${m.name})`);
      }
      const sec = secOf(m.name, s.section);
      symtab.set(s.name, {
        name: s.name,
        module: m.name,
        section: s.section,
        sectionOffset: s.offset,
        address: sec.address + s.offset,
      });
    }
  }

  // 重定位槽重叠检查(按模块+段)
  for (const m of modules) {
    for (const section of ["text", "data"] as SectionName[]) {
      const slots = m.relocations
        .filter((r) => r.section === section)
        .map((r) => r.offset)
        .sort((a, b) => a - b);
      for (let i = 1; i < slots.length; i++) {
        if (slots[i] < slots[i - 1] + 4) {
          fail("E_SLOT_OVERLAP", `模块 ${m.name} 段 ${section} 槽 ${slots[i - 1]} 与 ${slots[i]} 重叠`);
        }
      }
    }
  }

  // 全部校验(含范围)通过后才生成镜像
  interface Pending {
    mod: ParsedModule;
    r: Required<RelocDef>;
    slotOffset: number;
    slotAddress: number;
    S: number;
    symModule: string;
    value: number;
    u32: number;
    formula: string;
  }
  const pendings: Pending[] = [];
  for (const m of modules) {
    for (const r of m.relocations) {
      const sym = symtab.get(r.symbol);
      if (!sym) fail("E_UNDEF_SYMBOL", `模块 ${m.name} 引用了未定义符号 ${r.symbol}`);
      const sec = secOf(m.name, r.section);
      const P = sec.address + r.offset;
      const S = sym.address;
      const A = r.addend;
      let value: number;
      let u32: number;
      let formula: string;
      if (r.type === "ABS32") {
        value = S + A;
        if (value < 0 || value > UINT32_MAX) {
          fail("E_RELOC_RANGE", `ABS32 ${m.name}:${r.symbol} 值 ${value} 超出无符号 32 位范围`);
        }
        u32 = value;
        formula = `S+A = ${S}+${A} = ${value}`;
      } else {
        value = S + A - (P + 4);
        if (value < -0x80000000 || value > 0x7fffffff) {
          fail("E_RELOC_RANGE", `PCREL32 ${m.name}:${r.symbol} 位移 ${value} 超出有符号 32 位范围`);
        }
        u32 = value >>> 0;
        formula = `S+A-(P+4) = ${S}+${A}-(${P}+4) = ${value}`;
      }
      pendings.push({
        mod: m,
        r,
        slotOffset: sec.offset + r.offset,
        slotAddress: P,
        S,
        symModule: sym.module,
        value,
        u32,
        formula,
      });
    }
  }

  // 生成镜像:间隙补零,输入原字节不变(拷贝)
  const image = Buffer.alloc(cursor);
  for (const m of modules) {
    m.text.copy(image, secOf(m.name, "text").offset);
    m.data.copy(image, secOf(m.name, "data").offset);
  }

  const patches: PatchInfo[] = [];
  for (const p of pendings) {
    const before = image.subarray(p.slotOffset, p.slotOffset + 4);
    const beforeHex = before.toString("hex");
    const tmp = Buffer.alloc(4);
    tmp.writeUInt32LE(p.u32, 0);
    tmp.copy(image, p.slotOffset);
    patches.push({
      module: p.mod.name,
      section: p.r.section,
      sectionOffset: p.r.offset,
      slotOffset: p.slotOffset,
      slotAddress: p.slotAddress,
      type: p.r.type,
      symbol: p.r.symbol,
      symbolModule: p.symModule,
      S: p.S,
      A: p.r.addend,
      value: p.value,
      beforeHex,
      afterHex: tmp.toString("hex"),
      formula: p.formula,
    });
  }

  const symbols = [...symtab.values()];
  return { base, image, layout, symbols, patches };
}
