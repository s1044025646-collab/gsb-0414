import {
  LinkError, LinkResult, MAX_ADDRESS_SPACE, MAX_ALIGN, MAX_IMAGE_SIZE,
  ModuleInput, PatchInfo, RelocInput, SectionLayout, SectionName, SymbolEntry,
} from "./model.js";

const SECTION_ORDER: SectionName[] = ["text", "data"];

function isPowerOfTwo(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= MAX_ALIGN && (n & (n - 1)) === 0;
}

function alignUp(value: number, align: number): number {
  return Math.ceil(value / align) * align;
}

export function parseHexBytes(hex: string, ctx: string): Buffer {
  if (typeof hex !== "string" || !/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) {
    throw new LinkError("E_BAD_HEX", `${ctx}: 非法十六进制字节串`);
  }
  return Buffer.from(hex, "hex");
}

export function validateModule(mod: unknown, index: number): ModuleInput {
  const ctx = `模块[${index}]`;
  if (typeof mod !== "object" || mod === null) throw new LinkError("E_BAD_INPUT", `${ctx}: 不是对象`);
  const m = mod as ModuleInput;
  if (typeof m.name !== "string" || m.name.length === 0) {
    throw new LinkError("E_BAD_INPUT", `${ctx}: 缺少 name`);
  }
  for (const secName of SECTION_ORDER) {
    const sec = m[secName];
    if (sec === undefined) continue;
    if (typeof sec !== "object" || sec === null) throw new LinkError("E_BAD_INPUT", `${ctx}.${secName}: 不是对象`);
    if (!isPowerOfTwo(sec.align)) {
      throw new LinkError("E_BAD_ALIGN", `${ctx}.${secName}: align 必须是 1..${MAX_ALIGN} 的二次幂, 得到 ${sec.align}`);
    }
    parseHexBytes(sec.bytes, `${ctx}.${secName}`);
  }
  for (const sym of m.symbols ?? []) {
    if (typeof sym.name !== "string" || sym.name.length === 0) throw new LinkError("E_BAD_INPUT", `${ctx}: 符号名非法`);
    if (!SECTION_ORDER.includes(sym.section)) throw new LinkError("E_BAD_INPUT", `${ctx}: 符号 ${sym.name} 段名非法`);
    if (!Number.isInteger(sym.offset) || sym.offset < 0) throw new LinkError("E_BAD_INPUT", `${ctx}: 符号 ${sym.name} 偏移非法`);
  }
  for (const r of m.relocations ?? []) {
    if (!SECTION_ORDER.includes(r.section)) throw new LinkError("E_BAD_INPUT", `${ctx}: 重定位段名非法`);
    if (r.type !== "ABS32" && r.type !== "PCREL32") throw new LinkError("E_UNKNOWN_RELOC", `${ctx}: 未知重定位类型 ${r.type}`);
    if (!Number.isInteger(r.offset) || r.offset < 0) throw new LinkError("E_BAD_INPUT", `${ctx}: 重定位偏移非法`);
    if (!Number.isSafeInteger(r.addend) || r.addend < -(2 ** 31) || r.addend > 0xffffffff) {
      throw new LinkError("E_BAD_ADDEND", `${ctx}: 非法加数 ${r.addend}`);
    }
    if (typeof r.symbol !== "string" || r.symbol.length === 0) throw new LinkError("E_BAD_INPUT", `${ctx}: 重定位缺少符号名`);
  }
  return m;
}

export function linkModules(rawModules: unknown[], base: number): LinkResult {
  if (!Number.isSafeInteger(base) || base < 0 || base >= MAX_ADDRESS_SPACE) {
    throw new LinkError("E_BAD_BASE", `基址必须是 [0, 2^32) 内的整数, 得到 ${base}`);
  }
  if (!Array.isArray(rawModules) || rawModules.length === 0) {
    throw new LinkError("E_BAD_INPUT", "模块集合不能为空");
  }
  const modules = rawModules.map((m, i) => validateModule(m, i));

  // 1. 布局: 先全部 text, 再全部 data, 模块顺序保持输入顺序
  const sections: SectionLayout[] = [];
  const secBytes = new Map<string, Buffer>();
  let offset = 0;
  for (const secName of SECTION_ORDER) {
    for (const mod of modules) {
      const sec = mod[secName];
      if (!sec) continue;
      const bytes = parseHexBytes(sec.bytes, `${mod.name}.${secName}`);
      offset = alignUp(offset, sec.align);
      sections.push({
        module: mod.name, section: secName, align: sec.align,
        size: bytes.length, offset, address: base + offset, fileOffset: offset,
      });
      secBytes.set(`${mod.name}${secName}`, bytes);
      offset += bytes.length;
    }
  }
  if (offset > MAX_IMAGE_SIZE) {
    throw new LinkError("E_IMAGE_TOO_LARGE", `镜像大小 ${offset} 超过上限 ${MAX_IMAGE_SIZE}`);
  }
  if (base + offset > MAX_ADDRESS_SPACE) {
    throw new LinkError("E_ADDR_OVERFLOW", `基址 ${base} + 镜像大小 ${offset} 超出 32 位地址空间`);
  }

  // 2. 符号表: 强符号全局唯一
  const symbols = new Map<string, SymbolEntry>();
  for (const mod of modules) {
    for (const sym of mod.symbols ?? []) {
      if (symbols.has(sym.name)) {
        throw new LinkError("E_DUP_SYMBOL", `符号 "${sym.name}" 重复定义 (模块 "${symbols.get(sym.name)!.module}" 与 "${mod.name}")`);
      }
      const layout = sections.find((s) => s.module === mod.name && s.section === sym.section);
      if (!layout) throw new LinkError("E_BAD_INPUT", `符号 "${sym.name}" 引用了模块 "${mod.name}" 不存在的段 ${sym.section}`);
      if (sym.offset > layout.size) {
        throw new LinkError("E_SYMBOL_RANGE", `符号 "${sym.name}" 偏移 ${sym.offset} 越界 (段大小 ${layout.size})`);
      }
      symbols.set(sym.name, {
        name: sym.name, module: mod.name, section: sym.section,
        offset: sym.offset, address: layout.address + sym.offset,
      });
    }
  }

  // 3. 重定位校验 + 应用
  const image = Buffer.alloc(offset);
  for (const sec of sections) {
    secBytes.get(`${sec.module}${sec.section}`)!.copy(image, sec.offset);
  }

  const patches: PatchInfo[] = [];
  interface Slot extends RelocInput { module: string; }
  const allSlots: Slot[] = [];
  for (const mod of modules) {
    for (const r of mod.relocations ?? []) allSlots.push({ ...r, module: mod.name });
  }
  // 槽完整性 + 重叠检查
  const bySection = new Map<string, Slot[]>();
  for (const r of allSlots) {
    const layout = sections.find((s) => s.module === r.module && s.section === r.section);
    if (!layout) throw new LinkError("E_BAD_INPUT", `模块 "${r.module}" 的重定位引用了不存在的段 ${r.section}`);
    if (r.offset + 4 > layout.size) {
      throw new LinkError("E_SLOT_RANGE", `模块 "${r.module}" 段 ${r.section} 偏移 ${r.offset} 的槽不完整 (段大小 ${layout.size})`);
    }
    const key = `${r.module}${r.section}`;
    if (!bySection.has(key)) bySection.set(key, []);
    bySection.get(key)!.push(r);
  }
  for (const slots of bySection.values()) {
    slots.sort((a, b) => a.offset - b.offset);
    for (let i = 1; i < slots.length; i++) {
      if (slots[i].offset < slots[i - 1].offset + 4) {
        throw new LinkError("E_SLOT_OVERLAP", `模块 "${slots[i].module}" 段 ${slots[i].section} 偏移 ${slots[i].offset} 与 ${slots[i - 1].offset} 的补丁槽重叠`);
      }
    }
  }

  for (const r of allSlots) {
    const sym = symbols.get(r.symbol);
    if (!sym) throw new LinkError("E_UNDEF_SYMBOL", `模块 "${r.module}" 引用了未定义符号 "${r.symbol}"`);
    const layout = sections.find((s) => s.module === r.module && s.section === r.section)!;
    const S = sym.address;
    const P = layout.address + r.offset;
    let value: number;
    if (r.type === "ABS32") {
      const v = S + r.addend;
      if (v < 0 || v > 0xffffffff) {
        throw new LinkError("E_RELOC_RANGE", `ABS32: S+A = ${v} 超出无符号 32 位范围 (符号 "${r.symbol}")`);
      }
      value = v >>> 0;
    } else {
      const v = S + r.addend - (P + 4);
      if (v < -(2 ** 31) || v > 2 ** 31 - 1) {
        throw new LinkError("E_RELOC_RANGE", `PCREL32: S+A-(P+4) = ${v} 超出有符号 32 位范围 (符号 "${r.symbol}")`);
      }
      value = v >>> 0; // 补码
    }
    const imageOffset = layout.offset + r.offset;
    const before = image.subarray(imageOffset, imageOffset + 4).toString("hex");
    image.writeUInt32LE(value, imageOffset);
    const after = image.subarray(imageOffset, imageOffset + 4).toString("hex");
    patches.push({
      module: r.module, section: r.section, slotOffset: r.offset, slotAddress: P,
      imageOffset, type: r.type, symbol: r.symbol, symbolModule: sym.module,
      addend: r.addend, S, P, value, before, after,
    });
  }

  return {
    base, imageSize: offset, image,
    sections, symbols: [...symbols.values()], patches,
  };
}
