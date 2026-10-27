import { describe, expect, it } from "vitest";
import { decodeHeader, exactOffer, parseNameValue, parseSpent, refusalCode, type PaymentRequired } from "../src";

// Captured from the public Metal demo seller on testnet (GET /quote).
const DEMO_402 =
  "eyJ4NDAyVmVyc2lvbiI6MiwiZXJyb3IiOiJQYXltZW50IHJlcXVpcmVkIiwicmVzb3VyY2UiOnsidXJsIjoiaHR0cDovL3g0MDItZGVtby10ZXN0bmV0Lm1ldGFsbnR3eC5jb20vcXVvdGUiLCJkZXNjcmlwdGlvbiI6Ik9uZSBxdW90ZSwgcGFpZCBwZXIgcmVxdWVzdCIsIm1pbWVUeXBlIjoiIn0sImFjY2VwdHMiOlt7InNjaGVtZSI6ImJhamlsbGlvbiIsIm5ldHdvcmsiOiJlaXAxNTU6NjM4MjUiLCJhbW91bnQiOiIxMDAwMDAwMDAwMDAwMDAwMCIsImFzc2V0IjoiMHgwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDBCNWQ1IiwicGF5VG8iOiIweDAzNTMzZWI3YTQ4YzU5ZWVjNTRiNjU0ZDc2YjhkNjcyYzFmMDI2NjJhYTdiMTRlMWY1ZDc5MDdiNmY2NWQ5OTYwMyIsIm1heFRpbWVvdXRTZWNvbmRzIjo2MCwiZXh0cmEiOnsic2V0dGxlbWVudCI6IjB4YWIzY0MxNUE1QWQxODEyRDBCZkVBMjM5YmJjRjA3NmQyNDM3RWMyMiIsInNlcnZpY2VVcmwiOiJodHRwczovL2NsZWFyaW5nLXRlc3RuZXQubWV0YWxudHd4LmNvbSIsInBheW1lbnRGbG93IjoidXBmcm9udCIsImludm9pY2VQcmVmaXgiOiIweGVhZTZhMjdkOWE2OTk3ZjMzODZiMzg2ZjE4OGU1MmY0ODExMjRmMmVkYjFlODEwN2MxYzUwZmU0NWFhNTJmN2EifX0seyJzY2hlbWUiOiJleGFjdCIsIm5ldHdvcmsiOiJlaXAxNTU6NjM4MjUiLCJhbW91bnQiOiIxMDAwMDAwMDAwMDAwMDAwMCIsImFzc2V0IjoiMHgwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDBCNWQ1IiwicGF5VG8iOiIweGExZWE0NGFmZTM5NDg4MzExOTRjOTA0MzhmMjM4MjdjOGI0NThmODgiLCJtYXhUaW1lb3V0U2Vjb25kcyI6NjAsImV4dHJhIjp7Im5hbWUiOiJVU0QgWmVybyIsInZlcnNpb24iOiIxIiwicHJpbWFyeVR5cGUiOiJUcmFuc2ZlcldpdGhBdXRob3JpemF0aW9uIn19XX0=";

describe("x402 offers", () => {
  it("reads the exact USDZ offer from a real Metal 402", () => {
    const required = decodeHeader<PaymentRequired>(DEMO_402);
    const offer = exactOffer(required)!;
    expect(offer.price).toBe(1n);
    expect(offer.payTo).toBe("0xa1ea44afe3948831194c90438f23827c8b458f88");
    expect(offer.signedOrderRequired).toBe(false);
  });

  it("pulls refusal codes out of CLI messages", () => {
    expect(
      refusalCode("payment refused: mandate_cap_exceeded (the amount is above the mandate's per-payment cap) (offer: 7 *USDZ on eip155:63825); nothing was paid"),
    ).toBe("mandate_cap_exceeded");
    expect(refusalCode("something else")).toBe("payment_refused");
  });
});

describe("metal-agent output", () => {
  it("parses name value lines", () => {
    const lines = parseNameValue(
      "transaction 0xabc\noutcome paid\nspent 6.5 *USDZ of 10 *USDZ\npayer 0x1\npayee 0x2\namount 2.5 *USDZ\n",
    );
    expect(lines.get("outcome")).toEqual(["paid"]);
    expect(parseSpent(lines.get("spent")![0]!)).toEqual({ spent: 650n, budget: 1000n });
  });
});
