export type ErrorCode =
  | "E_BAD_INPUT"
  | "E_BAD_HEX"
  | "E_ALIGN"
  | "E_SECTION"
  | "E_SYM_OOB"
  | "E_DUP_SYMBOL"
  | "E_UNDEF_SYMBOL"
  | "E_UNKNOWN_RELOC"
  | "E_BAD_ADDEND"
  | "E_SLOT_OOB"
  | "E_SLOT_OVERLAP"
  | "E_RELOC_RANGE"
  | "E_IMAGE_TOO_LARGE"
  | "E_ADDR_RANGE"
  | "E_NOT_FOUND";

export class LinkError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public details?: unknown
  ) {
    super(message);
    this.name = "LinkError";
  }
}

export function fail(code: ErrorCode, message: string, details?: unknown): never {
  throw new LinkError(code, message, details);
}
