/**
 * GS1 Application Identifier parser.
 *
 * A GS1-128 / GS1 DataMatrix on a pharma carton packs several fields into one
 * string. Under Schedule H2 the code carries the product identification code,
 * batch, manufacturing date and expiry — so one scan can fill in product,
 * batch AND expiry, which is the whole point of the scan lane at goods receipt.
 *
 * The parsing problem: some AIs are fixed-length, some are variable-length and
 * terminated by the FNC1 separator (ASCII 29, GS). Scanners in HID mode often
 * emit FNC1 as \u001d, but not always — some emit nothing at all. So variable
 * fields are read greedily up to a separator, and if there is no separator we
 * fall back to scanning forward for the next known AI prefix.
 */

/** Fixed-length AIs: the value length is implied, no separator follows. */
const FIXED_LENGTH: Record<string, number> = {
  '00': 18, // SSCC
  '01': 14, // GTIN
  '02': 14, // GTIN of contained trade items
  '11': 6,  // production date   YYMMDD
  '12': 6,  // due date
  '13': 6,  // packaging date
  '15': 6,  // best before
  '16': 6,  // sell by
  '17': 6,  // EXPIRY           YYMMDD
  '20': 2,  // variant
};

/** Variable-length AIs we care about, with their max length. */
const VARIABLE_LENGTH: Record<string, number> = {
  '10': 20, // BATCH / LOT
  '21': 20, // serial number
  '30': 8,  // count of items
  '240': 30, // additional product identification (some Indian packs use this)
  '241': 30, // customer part number
  '710': 20, // national healthcare reimbursement number
};

const GS = '\u001d'; // FNC1 separator

export interface Gs1Result {
  gtin?: string;
  batchNo?: string;
  expiryDate?: Date;
  mfgDate?: Date;
  serial?: string;
  count?: number;
  /** AIs we recognised but do not map to a named field. */
  extra: Record<string, string>;
  /** True if the whole string was consumed without hitting an unknown AI. */
  complete: boolean;
}

/**
 * YYMMDD -> Date.
 *
 * Two rules that matter for medicine:
 *  - GS1 defines DD=00 as "last day of the month", which is exactly how pharma
 *    expiry is printed (MM/YYYY). We return the real last day of that month.
 *  - The century window: GS1 says a year 51..99 is 19xx, 00..50 is 20xx.
 */
export function parseGs1Date(yymmdd: string): Date | undefined {
  if (!/^\d{6}$/.test(yymmdd)) return undefined;
  const yy = Number(yymmdd.slice(0, 2));
  const mm = Number(yymmdd.slice(2, 4));
  const dd = Number(yymmdd.slice(4, 6));
  if (mm < 1 || mm > 12) return undefined;

  const year = yy <= 50 ? 2000 + yy : 1900 + yy;

  if (dd === 0) {
    // last day of the month, in UTC
    return new Date(Date.UTC(year, mm, 0));
  }
  if (dd > 31) return undefined;
  return new Date(Date.UTC(year, mm - 1, dd));
}

/** GTIN-14 mod-10 check digit. Rejects transcription errors and fake codes. */
export function isValidGtin(gtin: string): boolean {
  if (!/^\d{8}$|^\d{12,14}$/.test(gtin)) return false;
  const digits = gtin.split('').map(Number);
  const check = digits.pop()!;
  let sum = 0;
  // weights alternate 3,1 from the rightmost body digit leftwards
  for (let i = digits.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) {
    sum += digits[i] * w;
  }
  return (10 - (sum % 10)) % 10 === check;
}

type Field = [ai: string, value: string];

function readAi(s: string, i: number): string | null {
  // AI is 2 or 3 digits. Check 3 first so '240' is not truncated to '24'.
  const three = s.slice(i, i + 3);
  if (three in FIXED_LENGTH || three in VARIABLE_LENGTH) return three;
  const two = s.slice(i, i + 2);
  if (two in FIXED_LENGTH || two in VARIABLE_LENGTH) return two;
  return null;
}

/**
 * Parse from position `i` to the END of the string, or return null.
 *
 * Why backtracking rather than a single forward scan: when the scanner drops
 * the FNC1 separators, a variable-length field has no marked end. Scanning
 * forward for "the next thing that looks like an AI" is wrong, because real
 * data contains digit pairs that look like AIs — the serial SER00981 contains
 * '00' (SSCC) and the batch BN447121 contains '12' (due date). A forward scanner
 * silently truncates the batch number, which at goods receipt means stock filed
 * under a batch that does not exist.
 *
 * So instead: try every split, keep only parses that consume the whole string,
 * and choose the one that recognises the MOST fields. For 10BN447121SER00981
 * that uniquely selects batch=BN4471, serial=SER00981.
 */
function parseAll(s: string, i: number, depth = 0): Field[] | null {
  if (i >= s.length) return [];
  if (depth > 16) return null;                  // pathological input guard

  if (s[i] === GS) return parseAll(s, i + 1, depth);

  const ai = readAi(s, i);
  if (ai === null) return null;
  const valueStart = i + ai.length;

  if (ai in FIXED_LENGTH) {
    const len = FIXED_LENGTH[ai];
    if (valueStart + len > s.length) return null;
    const value = s.slice(valueStart, valueStart + len);
    if (!/^[\x20-\x7e]+$/.test(value) || value.includes(GS)) return null;
    const rest = parseAll(s, valueStart + len, depth + 1);
    return rest === null ? null : [[ai, value], ...rest];
  }

  const maxLen = VARIABLE_LENGTH[ai];
  const sepAt = s.indexOf(GS, valueStart);

  if (sepAt !== -1 && sepAt - valueStart <= maxLen) {
    // Separator present: the boundary is unambiguous, no guessing needed.
    const value = s.slice(valueStart, sepAt);
    if (!value) return null;
    const rest = parseAll(s, sepAt + 1, depth + 1);
    return rest === null ? null : [[ai, value], ...rest];
  }

  const available = s.length - valueStart;
  let best: Field[] | null = null;
  // Descending, so that on a tie in field count we keep the longer value.
  for (let len = Math.min(maxLen, available); len >= 1; len--) {
    const value = s.slice(valueStart, valueStart + len);
    if (value.includes(GS)) continue;
    const rest = parseAll(s, valueStart + len, depth + 1);
    if (rest === null) continue;
    const candidate: Field[] = [[ai, value], ...rest];
    if (best === null || candidate.length > best.length) best = candidate;
  }
  return best;
}

/** Lenient forward scan, used only to salvage something from a broken code. */
function parsePartial(s: string): Field[] {
  const out: Field[] = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === GS) { i++; continue; }
    const ai = readAi(s, i);
    if (ai === null) break;
    const start = i + ai.length;
    if (ai in FIXED_LENGTH) {
      const len = FIXED_LENGTH[ai];
      if (start + len > s.length) break;
      out.push([ai, s.slice(start, start + len)]);
      i = start + len;
    } else {
      const sepAt = s.indexOf(GS, start);
      const end = sepAt === -1 ? Math.min(s.length, start + VARIABLE_LENGTH[ai]) : sepAt;
      out.push([ai, s.slice(start, end)]);
      i = sepAt === -1 ? end : sepAt + 1;
    }
  }
  return out;
}

function assemble(fields: Field[], complete: boolean): Gs1Result {
  const out: Gs1Result = { extra: {}, complete };
  for (const [ai, value] of fields) {
    switch (ai) {
      case '01':
      case '02': out.gtin = value; break;
      case '10': out.batchNo = value; break;
      case '17': out.expiryDate = parseGs1Date(value); break;
      case '11': out.mfgDate = parseGs1Date(value); break;
      case '21': out.serial = value; break;
      case '30': out.count = Number(value); break;
      default:   out.extra[ai] = value;
    }
  }
  return out;
}

export function parseGs1(raw: string): Gs1Result {
  if (!raw) return { extra: {}, complete: false };

  // Strip a leading FNC1 and any ]d2 / ]C1 symbology identifier the scanner adds.
  const s = raw.replace(/^\]\w\d/, '').replace(/^\u001d/, '');

  const full = parseAll(s, 0);
  if (full !== null && full.length > 0) return assemble(full, true);
  return assemble(parsePartial(s), false);
}

/**
 * Classify whatever the scanner just typed, so the stock-in screen knows which
 * lane it is in: full GS1 (product + batch + expiry), a plain retail barcode
 * (product only), or something we have never seen.
 */
export type ScanKind = 'gs1' | 'ean13' | 'ean8' | 'unknown';

export function classifyScan(raw: string): { kind: ScanKind; gs1?: Gs1Result } {
  const s = raw.trim();
  if (!s) return { kind: 'unknown' };

  if (s.includes(GS) || /^\]\w\d/.test(s) || /^01\d{14}/.test(s)) {
    const gs1 = parseGs1(s);
    if (gs1.gtin) return { kind: 'gs1', gs1 };
  }
  if (/^\d{13}$/.test(s) && isValidGtin(s)) return { kind: 'ean13' };
  if (/^\d{8}$/.test(s) && isValidGtin(s)) return { kind: 'ean8' };
  return { kind: 'unknown' };
}
