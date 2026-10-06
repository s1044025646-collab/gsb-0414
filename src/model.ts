export type SectionName = "text" | "data";
export type RelocType = "ABS32" | "PCREL32";

export interface SectionInput {
  bytes: string; // hex
  align: number; // power of two
}

export interface SymbolInput {
  name: string;
  section: SectionName;
  offset: number;
}

export interface RelocInput {
  section: SectionName;
  offset: number;
  type: RelocType;
  symbol: string;
  addend: number;
}

export interface ModuleInput {
  name: string;
  text?: SectionInput;
  data?: SectionInput;
  symbols?: SymbolInput[];
  relocations?: RelocInput[];
}

export interface SectionLayout {
  module: string;
  section: SectionName;
  align: number;
  size: number;
  offset: number;   // offset within image
  address: number;  // base + offset
  fileOffset: number; // offset within output file (== offset)
}

export interface SymbolEntry {
  name: string;
  module: string;
  section: SectionName;
  offset: number;
  address: number;
}

export interface PatchInfo {
  module: string;
  section: SectionName;
  slotOffset: number;   // offset of slot within its section
  slotAddress: number;  // P
  imageOffset: number;
  type: RelocType;
  symbol: string;
  symbolModule: string;
  addend: number;
  S: number;
  P: number;
  value: number;        // raw 32-bit value written
  before: string;       // hex, 4 bytes
  after: string;        // hex, 4 bytes
}

export interface LinkResult {
  base: number;
  imageSize: number;
  image: Buffer;
  sections: SectionLayout[];
  symbols: SymbolEntry[];
  patches: PatchInfo[];
}

export class LinkError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "LinkError";
  }
}

export const MAX_IMAGE_SIZE = 16 * 1024 * 1024; // 16 MiB
export const MAX_ALIGN = 4096;
export const MAX_ADDRESS_SPACE = 0x1_0000_0000; // 2^32
