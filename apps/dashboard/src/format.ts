export const cents = (v: unknown): bigint => {
  try {
    return BigInt(String(v ?? 0));
  } catch {
    return 0n;
  }
};

export function money(v: unknown, unit = "USDZ"): string {
  const c = cents(v);
  const neg = c < 0n;
  const abs = neg ? -c : c;
  const s = `${neg ? "−" : ""}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
  return unit ? `${s} ${unit}` : s;
}

export const short = (h: unknown, head = 6, tail = 4) => {
  const s = String(h ?? "");
  return s.length > head + tail + 2 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s;
};

export const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export const pct = (part: bigint, whole: bigint) => (whole === 0n ? 0 : Number((part * 10000n) / whole) / 100);

export const LETTER = { sourcing: "S", support: "R", treasury: "T" } as const;
export const ROLE_NAME = { sourcing: "Sourcing", support: "Support", treasury: "Treasury" } as const;
export const ROLE_JOB = {
  sourcing: "Buys upstream quotes from listed feeds",
  support: "Refunds buyers, any payee, small cap",
  treasury: "Sweeps to the Airwallex ramp only",
} as const;
