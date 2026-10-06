export type SectionName = "text" | "data";
export type RelocType = "ABS32" | "PCREL32";

export interface SymbolDef {
  name: string;
  section: SectionName;
  offset: number;
}

export interface RelocDef {
  section: SectionName;
  offset: number;
  type: RelocType;
  symbol: string;
  addend?: number;
}

export interface SectionInput {
  align: number;
  bytes: string; // hex string, may be empty
}

export interface ModuleInput {
  name: string;
  text?: SectionInput;
  data?: SectionInput;
  symbols?: SymbolDef[];
  relocations?: RelocDef[];
}

export interface SectionLayout {
  module: string;
  section: SectionName;
  align: number;
  size: number;
  offset: number; // offset within image
  address: number; // base + offset
  fileOffset: number; // identical to offset in this flat format
}

export interface SymbolEntry {
  name: string;
  module: string;
  section: SectionName;
  sectionOffset: number;
  address: number;
}

export interface PatchInfo {
  module: string;
  section: SectionName;
  sectionOffset: number;
  slotOffset: number; // offset within image
  slotAddress: number; // P
  type: RelocType;
  symbol: string;
  symbolModule: string;
  S: number;
  A: number;
  value: number; // signed for PCREL32, unsigned for ABS32
  beforeHex: string;
  afterHex: string;
  formula: string;
}

export interface LinkResult {
  base: number;
  image: Buffer;
  layout: SectionLayout[];
  symbols: SymbolEntry[];
  patches: PatchInfo[];
}
