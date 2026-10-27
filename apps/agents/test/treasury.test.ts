import { describe, expect, it } from "vitest";
import { ibanValid } from "../src/treasury";

describe("IBAN check", () => {
  it("accepts valid IBANs with or without spaces", () => {
    expect(ibanValid("DE89370400440532013000")).toBe(true);
    expect(ibanValid("DE89 3704 0044 0532 0130 00")).toBe(true);
    expect(ibanValid("GB82WEST12345698765432")).toBe(true);
  });

  it("rejects a mistyped digit or a malformed string", () => {
    expect(ibanValid("DE89370400440532013001")).toBe(false);
    expect(ibanValid("not an iban")).toBe(false);
  });
});
