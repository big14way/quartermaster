// All money inside Quartermaster is integer cents (bigint). USDZ is converted to its
// 18-decimal base units only at the Metal boundary, and Airwallex decimal strings are
// converted at the Airwallex boundary.

export type Cents = bigint;

const USDZ_DECIMALS = 18n;
const BASE_PER_CENT = 10n ** (USDZ_DECIMALS - 2n);

const DECIMAL_RE = /^(-)?(\d+)(?:\.(\d+))?$/;

export type Rounding = "exact" | "up" | "down" | "half-up";

/** Parse a decimal string in major units ("12.5", "0.05") into cents. */
export function toCents(value: string | number, rounding: Rounding = "exact"): Cents {
  const text = typeof value === "number" ? numberToPlainString(value) : value.trim();
  const m = DECIMAL_RE.exec(text);
  if (!m) throw new Error(`not a decimal amount: ${JSON.stringify(value)}`);
  const [, sign, whole, frac = ""] = m;
  const head = frac.slice(0, 2).padEnd(2, "0");
  const tail = frac.slice(2);
  let cents = BigInt(whole!) * 100n + BigInt(head);
  const hasTail = /[1-9]/.test(tail);
  if (hasTail) {
    if (rounding === "exact") throw new Error(`amount ${text} is finer than a cent`);
    if (rounding === "up" && !sign) cents += 1n;
    if (rounding === "down" && sign) cents += 1n;
    if (rounding === "half-up" && Number(tail[0]) >= 5) cents += 1n;
  }
  return sign ? -cents : cents;
}

/** Format cents as a fixed two-decimal string ("0.05", "-1.20"). */
export function fromCents(cents: Cents): string {
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

/** "0.05 USDZ" style label for UI and logs. */
export function usdz(cents: Cents): string {
  return `${fromCents(cents)} USDZ`;
}

export function centsToBaseUnits(cents: Cents): bigint {
  return cents * BASE_PER_CENT;
}

/** Convert 18-decimal USDZ base units to cents. Throws if the value is not a whole cent. */
export function baseUnitsToCents(base: bigint | string, rounding: Rounding = "exact"): Cents {
  const b = typeof base === "string" ? BigInt(base) : base;
  const rem = b % BASE_PER_CENT;
  const cents = b / BASE_PER_CENT;
  if (rem === 0n) return cents;
  if (rounding === "exact") throw new Error(`base amount ${b} is not a whole cent`);
  if (rounding === "up") return cents + 1n;
  if (rounding === "half-up") return rem * 2n >= BASE_PER_CENT ? cents + 1n : cents;
  return cents;
}

export function sumCents(values: Iterable<Cents>): Cents {
  let t = 0n;
  for (const v of values) t += v;
  return t;
}

export function maxCents(a: Cents, b: Cents): Cents {
  return a > b ? a : b;
}

export function minCents(a: Cents, b: Cents): Cents {
  return a < b ? a : b;
}

/** Round cents up to a multiple of `step` cents (e.g. 10n rounds to the next 0.10). */
export function ceilTo(cents: Cents, step: Cents): Cents {
  if (step <= 0n) throw new Error("step must be positive");
  const r = cents % step;
  return r === 0n ? cents : cents + (step - r);
}

/** Percentage change from `from` to `to`, in basis points (10000 = 100%). */
export function changeBps(from: Cents, to: Cents): bigint {
  if (from === 0n) return to === 0n ? 0n : 1_000_000n;
  return ((to - from) * 10_000n) / from;
}

function numberToPlainString(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`not a finite amount: ${n}`);
  // toFixed(8) avoids exponent notation for small values; trailing zeros are harmless.
  return n.toFixed(8);
}
