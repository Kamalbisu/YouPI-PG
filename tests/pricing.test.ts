import { describe, expect, it } from "vitest";
import {
  allocateProportionally,
  applyOffer,
  effectiveTaxBps,
  extractTax,
  MAX_QUANTITY,
  MAX_TOTAL_MINOR,
  percentOf,
  priceCart,
  priceLine,
  unitPriceAfterDiscount,
  type CartLineInput,
  type LineInput,
  type OfferRule,
} from "@/lib/pricing";

const line = (o: Partial<LineInput> = {}): LineInput => ({
  unitPriceMinor: 10000,
  quantity: 1,
  taxBps: 0,
  discountType: "NONE",
  discountValue: 0,
  pricesIncludeTax: false,
  ...o,
});

const cl = (o: Partial<CartLineInput> = {}): CartLineInput => ({
  unitPriceMinor: 10000,
  quantity: 1,
  taxBps: 0,
  discountType: "NONE",
  discountValue: 0,
  ...o,
});

const offer = (o: Partial<OfferRule> = {}): OfferRule => ({
  type: "PERCENT",
  value: 1000,
  minOrderMinor: 0,
  maxDiscountMinor: null,
  validFrom: null,
  validTo: null,
  usageLimit: null,
  usedCount: 0,
  isActive: true,
  ...o,
});

describe("rounding helpers", () => {
  it("rounds half up", () => {
    expect(percentOf(1, 5000)).toBe(1); // 0.5 -> 1
    expect(percentOf(3, 5000)).toBe(2); // 1.5 -> 2
    expect(percentOf(1, 4999)).toBe(0);
    expect(percentOf(10, 1500)).toBe(2); // 1.5 -> 2
    expect(percentOf(0, 1800)).toBe(0);
    expect(percentOf(9_999_999_99, 10000)).toBe(9_999_999_99);
  });
  it("extracts tax from an inclusive amount", () => {
    expect(extractTax(11800, 1800)).toBe(1800);
    expect(extractTax(10000, 1800)).toBe(1525); // 1525.42 -> 1525
    expect(extractTax(100, 1800)).toBe(15); // 15.25
    expect(extractTax(5, 1800)).toBe(1); // 0.76 -> 1
    expect(extractTax(1234, 0)).toBe(0);
  });
  it("does not overflow on very large values", () => {
    expect(percentOf(2_000_000_000, 10000)).toBe(2_000_000_000);
  });
});

describe("priceLine - exclusive tax", () => {
  it("adds tax on top of the price", () => {
    const r = priceLine(line({ unitPriceMinor: 10000, quantity: 3, taxBps: 1800 }));
    expect(r).toMatchObject({ grossMinor: 30000, discountMinor: 0, taxableMinor: 30000, taxMinor: 5400, netMinor: 30000, totalMinor: 35400 });
  });
  it("zero tax leaves the total equal to the price", () => {
    expect(priceLine(line({ quantity: 2 })).totalMinor).toBe(20000);
  });
  it("rounds tax half up per line", () => {
    // 1 paise * 18% = 0.18 -> 0; 3 paise = 0.54 -> 1; 5000 bps on 1 paise = 0.5 -> 1
    expect(priceLine(line({ unitPriceMinor: 1, taxBps: 1800 })).taxMinor).toBe(0);
    expect(priceLine(line({ unitPriceMinor: 3, taxBps: 1800 })).taxMinor).toBe(1);
    expect(priceLine(line({ unitPriceMinor: 1, taxBps: 5000 })).taxMinor).toBe(1);
    expect(priceLine(line({ unitPriceMinor: 999, taxBps: 500 })).taxMinor).toBe(50); // 49.95
  });
  it("applies percent discount before tax", () => {
    const r = priceLine(line({ unitPriceMinor: 20000, quantity: 1, taxBps: 1800, discountType: "PERCENT", discountValue: 1000 }));
    expect(r.discountMinor).toBe(2000);
    expect(r.taxableMinor).toBe(18000);
    expect(r.taxMinor).toBe(3240);
    expect(r.totalMinor).toBe(21240);
  });
  it("applies a fixed discount per unit before tax", () => {
    const r = priceLine(line({ unitPriceMinor: 5000, quantity: 4, taxBps: 1200, discountType: "FIXED", discountValue: 500 }));
    expect(r.grossMinor).toBe(20000);
    expect(r.discountMinor).toBe(2000);
    expect(r.taxableMinor).toBe(18000);
    expect(r.taxMinor).toBe(2160);
    expect(r.totalMinor).toBe(20160);
  });
  it("a 100% discount gives a zero total and zero tax", () => {
    const r = priceLine(line({ taxBps: 1800, discountType: "PERCENT", discountValue: 10000 }));
    expect(r).toMatchObject({ discountMinor: 10000, taxableMinor: 0, taxMinor: 0, totalMinor: 0 });
  });
  it("a fixed discount equal to the price gives zero", () => {
    expect(priceLine(line({ discountType: "FIXED", discountValue: 10000 })).totalMinor).toBe(0);
  });
  it("ignores discountValue when the type is NONE", () => {
    expect(priceLine(line({ discountType: "NONE", discountValue: 999999 })).totalMinor).toBe(10000);
  });
});

describe("priceLine - inclusive tax", () => {
  it("extracts tax from the listed price and keeps the total", () => {
    const r = priceLine(line({ unitPriceMinor: 11800, taxBps: 1800, pricesIncludeTax: true }));
    expect(r).toMatchObject({ grossMinor: 11800, taxMinor: 1800, netMinor: 10000, totalMinor: 11800 });
  });
  it("rounds extracted tax half up", () => {
    const r = priceLine(line({ unitPriceMinor: 10000, taxBps: 1800, pricesIncludeTax: true }));
    expect(r.taxMinor).toBe(1525);
    expect(r.netMinor).toBe(8475);
    expect(r.netMinor + r.taxMinor).toBe(r.totalMinor);
    expect(r.totalMinor).toBe(10000);
  });
  it("discounts reduce the total and the tax contained in it", () => {
    const r = priceLine(line({ unitPriceMinor: 11800, taxBps: 1800, pricesIncludeTax: true, discountType: "PERCENT", discountValue: 5000 }));
    expect(r.discountMinor).toBe(5900);
    expect(r.totalMinor).toBe(5900);
    expect(r.taxMinor).toBe(900);
    expect(r.netMinor).toBe(5000);
  });
  it("zero tax rate means no tax is extracted", () => {
    const r = priceLine(line({ pricesIncludeTax: true, taxBps: 0 }));
    expect(r.taxMinor).toBe(0);
    expect(r.totalMinor).toBe(10000);
  });
});

describe("priceLine - invalid input is rejected", () => {
  const bad: Array<[string, Partial<LineInput>]> = [
    ["zero price", { unitPriceMinor: 0 }],
    ["negative price", { unitPriceMinor: -100 }],
    ["fractional price", { unitPriceMinor: 10.5 }],
    ["NaN price", { unitPriceMinor: Number.NaN }],
    ["price above one crore rupees", { unitPriceMinor: 10_000_000_01 }],
    ["zero quantity", { quantity: 0 }],
    ["negative quantity", { quantity: -1 }],
    ["fractional quantity", { quantity: 1.5 }],
    ["quantity over the cap", { quantity: MAX_QUANTITY + 1 }],
    ["negative tax", { taxBps: -1 }],
    ["tax above 100%", { taxBps: 10001 }],
    ["fractional tax", { taxBps: 18.5 }],
    ["negative discount", { discountType: "PERCENT", discountValue: -1 }],
    ["percent discount above 100%", { discountType: "PERCENT", discountValue: 10001 }],
    ["fixed discount above the price", { discountType: "FIXED", discountValue: 10001 }],
    ["negative fixed discount", { discountType: "FIXED", discountValue: -5 }],
    ["unknown discount type", { discountType: "BOGUS" as never }],
  ];
  for (const [name, patch] of bad) {
    it(`rejects ${name}`, () => {
      expect(() => priceLine(line(patch))).toThrow();
    });
  }
  it("rejects a line total above the storage limit", () => {
    expect(() => priceLine(line({ unitPriceMinor: 10_000_000_00, quantity: 5 }))).toThrow(/too large/i);
  });
  it("throws an AppError with a BAD_REQUEST code", () => {
    try {
      priceLine(line({ unitPriceMinor: 0 }));
      expect.unreachable();
    } catch (e) {
      expect((e as { code?: string }).code).toBe("BAD_REQUEST");
    }
  });
});

describe("unitPriceAfterDiscount and effectiveTaxBps", () => {
  it("computes the display price", () => {
    expect(unitPriceAfterDiscount({ priceMinor: 10000, discountType: "NONE", discountValue: 0 })).toBe(10000);
    expect(unitPriceAfterDiscount({ priceMinor: 10000, discountType: "PERCENT", discountValue: 2500 })).toBe(7500);
    expect(unitPriceAfterDiscount({ priceMinor: 10000, discountType: "FIXED", discountValue: 1500 })).toBe(8500);
    expect(unitPriceAfterDiscount({ priceMinor: 10000, discountType: "FIXED", discountValue: 10000 })).toBe(1);
  });
  it("prefers the product tax over the business default, including zero", () => {
    expect(effectiveTaxBps({ taxBps: null }, { defaultTaxBps: 1800 })).toBe(1800);
    expect(effectiveTaxBps({ taxBps: 500 }, { defaultTaxBps: 1800 })).toBe(500);
    expect(effectiveTaxBps({ taxBps: 0 }, { defaultTaxBps: 1800 })).toBe(0);
  });
});

describe("applyOffer", () => {
  const now = new Date("2026-06-15T12:00:00Z");
  it("applies a percent offer", () => {
    expect(applyOffer(offer({ value: 1000 }), 25000, now)).toEqual({ ok: true, discountMinor: 2500 });
  });
  it("applies a fixed offer", () => {
    expect(applyOffer(offer({ type: "FIXED", value: 3000 }), 25000, now)).toEqual({ ok: true, discountMinor: 3000 });
  });
  it("caps a fixed offer at the cart amount", () => {
    expect(applyOffer(offer({ type: "FIXED", value: 90000 }), 25000, now)).toEqual({ ok: true, discountMinor: 25000 });
  });
  it("respects maxDiscountMinor", () => {
    expect(applyOffer(offer({ value: 5000, maxDiscountMinor: 1000 }), 25000, now)).toEqual({ ok: true, discountMinor: 1000 });
    expect(applyOffer(offer({ type: "FIXED", value: 5000, maxDiscountMinor: 1000 }), 25000, now)).toEqual({ ok: true, discountMinor: 1000 });
  });
  it("rounds a percent offer half up", () => {
    expect(applyOffer(offer({ value: 5000 }), 3, now)).toEqual({ ok: true, discountMinor: 2 });
  });
  it("enforces the minimum order, inclusive", () => {
    expect(applyOffer(offer({ minOrderMinor: 25000 }), 24999, now)).toEqual({ ok: false, reason: "MIN_ORDER" });
    expect(applyOffer(offer({ minOrderMinor: 25000 }), 25000, now).ok).toBe(true);
  });
  it("enforces the validity window, inclusive at both ends", () => {
    const from = new Date("2026-06-15T12:00:00Z");
    const to = new Date("2026-06-20T12:00:00Z");
    expect(applyOffer(offer({ validFrom: from, validTo: to }), 1000, from).ok).toBe(true);
    expect(applyOffer(offer({ validFrom: from, validTo: to }), 1000, to).ok).toBe(true);
    expect(applyOffer(offer({ validFrom: from, validTo: to }), 1000, new Date(from.getTime() - 1))).toEqual({ ok: false, reason: "NOT_STARTED" });
    expect(applyOffer(offer({ validFrom: from, validTo: to }), 1000, new Date(to.getTime() + 1))).toEqual({ ok: false, reason: "EXPIRED" });
  });
  it("enforces the usage limit", () => {
    expect(applyOffer(offer({ usageLimit: 5, usedCount: 4 }), 1000, now).ok).toBe(true);
    expect(applyOffer(offer({ usageLimit: 5, usedCount: 5 }), 1000, now)).toEqual({ ok: false, reason: "USAGE_LIMIT" });
    expect(applyOffer(offer({ usageLimit: 5, usedCount: 9 }), 1000, now)).toEqual({ ok: false, reason: "USAGE_LIMIT" });
    expect(applyOffer(offer({ usageLimit: null, usedCount: 999 }), 1000, now).ok).toBe(true);
  });
  it("rejects an inactive offer", () => {
    expect(applyOffer(offer({ isActive: false }), 1000, now)).toEqual({ ok: false, reason: "INACTIVE" });
  });
  it("rejects malformed offers and amounts", () => {
    expect(applyOffer(offer({ value: -1 }), 1000, now)).toEqual({ ok: false, reason: "INVALID" });
    expect(applyOffer(offer({ value: 10001 }), 1000, now)).toEqual({ ok: false, reason: "INVALID" });
    expect(applyOffer(offer(), -5, now)).toEqual({ ok: false, reason: "INVALID" });
    expect(applyOffer(offer(), 10.5, now)).toEqual({ ok: false, reason: "INVALID" });
  });
});

describe("allocateProportionally", () => {
  it("always sums to the total and never exceeds a weight", () => {
    const cases: Array<[number, number[]]> = [
      [100, [100, 100, 100]],
      [7, [3, 3, 3]],
      [1, [5, 5]],
      [10, [10, 0, 0]],
      [1000, [3333, 3333, 3334]],
    ];
    for (const [t, w] of cases) {
      const a = allocateProportionally(t, w);
      expect(a.reduce((x, y) => x + y, 0)).toBe(t);
      a.forEach((v, i) => expect(v).toBeLessThanOrEqual(w[i]));
    }
  });
  it("gives leftover paise to the earliest line on a tie", () => {
    expect(allocateProportionally(100, [100, 100, 100])).toEqual([34, 33, 33]);
  });
  it("returns zeros for a zero total", () => {
    expect(allocateProportionally(0, [5, 5])).toEqual([0, 0]);
  });
});

describe("priceCart", () => {
  it("prices an exclusive cart and satisfies the identities", () => {
    const r = priceCart([cl({ unitPriceMinor: 10000, quantity: 2, taxBps: 1800 }), cl({ unitPriceMinor: 5050, quantity: 1, taxBps: 500 })], { pricesIncludeTax: false });
    expect(r.subtotalMinor).toBe(25050);
    expect(r.discountMinor).toBe(0);
    expect(r.taxMinor).toBe(3600 + 253); // 252.5 -> 253
    expect(r.totalMinor).toBe(25050 + 3853);
    expect(r.netMinor + r.taxMinor).toBe(r.totalMinor);
    expect(r.offer).toBeNull();
  });

  it("prices an inclusive cart: total equals subtotal less discount", () => {
    const r = priceCart([cl({ unitPriceMinor: 11800, quantity: 2, taxBps: 1800 })], { pricesIncludeTax: true });
    expect(r.subtotalMinor).toBe(23600);
    expect(r.taxMinor).toBe(3600);
    expect(r.totalMinor).toBe(23600);
    expect(r.netMinor).toBe(20000);
    expect(r.pricesIncludeTax).toBe(true);
  });

  it("applies product discounts first, then the coupon, then tax (exclusive)", () => {
    const r = priceCart(
      [cl({ unitPriceMinor: 20000, taxBps: 1800, discountType: "PERCENT", discountValue: 1000 })],
      { pricesIncludeTax: false, offer: offer({ type: "FIXED", value: 3000 }) },
    );
    // 20000 - 2000 (product) = 18000; coupon 3000 -> 15000 taxable; tax 2700; total 17700
    expect(r.productDiscountMinor).toBe(2000);
    expect(r.offerDiscountMinor).toBe(3000);
    expect(r.discountMinor).toBe(5000);
    expect(r.taxMinor).toBe(2700);
    expect(r.totalMinor).toBe(17700);
    expect(r.offer).toEqual({ applied: true, discountMinor: 3000 });
  });

  it("computes a percent coupon on the amount after product discounts", () => {
    const r = priceCart(
      [cl({ unitPriceMinor: 10000, discountType: "FIXED", discountValue: 2000 })],
      { pricesIncludeTax: false, offer: offer({ value: 1000 }) },
    );
    expect(r.offerDiscountMinor).toBe(800); // 10% of 8000
    expect(r.totalMinor).toBe(7200);
  });

  it("splits a coupon across lines so every line and the cart add up exactly", () => {
    const lines = [cl({ unitPriceMinor: 3333, taxBps: 1800 }), cl({ unitPriceMinor: 3333, taxBps: 500 }), cl({ unitPriceMinor: 3334, taxBps: 0 })];
    const r = priceCart(lines, { pricesIncludeTax: false, offer: offer({ type: "FIXED", value: 1000 }) });
    expect(r.lines.reduce((a, l) => a + l.offerDiscountMinor, 0)).toBe(1000);
    expect(r.lines.map((l) => l.offerDiscountMinor)).toEqual([333, 333, 334]);
    expect(r.totalMinor).toBe(r.lines.reduce((a, l) => a + l.totalMinor, 0));
    expect(r.taxMinor).toBe(r.lines.reduce((a, l) => a + l.taxMinor, 0));
    expect(r.subtotalMinor - r.discountMinor + r.taxMinor).toBe(r.totalMinor);
  });

  it("coupon with inclusive pricing reduces total and the tax inside it", () => {
    const r = priceCart([cl({ unitPriceMinor: 11800, taxBps: 1800 })], { pricesIncludeTax: true, offer: offer({ type: "FIXED", value: 1180 }) });
    expect(r.totalMinor).toBe(10620);
    expect(r.taxMinor).toBe(1620);
    expect(r.subtotalMinor - r.discountMinor).toBe(r.totalMinor);
  });

  it("checks the minimum order against the amount after product discounts", () => {
    const l = [cl({ unitPriceMinor: 10000, discountType: "PERCENT", discountValue: 2000 })]; // base 8000
    expect(() => priceCart(l, { pricesIncludeTax: false, offer: offer({ minOrderMinor: 9000 }) })).toThrow(/minimum/i);
    expect(priceCart(l, { pricesIncludeTax: false, offer: offer({ minOrderMinor: 8000 }) }).offer?.applied).toBe(true);
  });

  it("throws for an expired offer by default and can ignore it instead", () => {
    const expired = offer({ validTo: new Date("2020-01-01") });
    try {
      priceCart([cl()], { pricesIncludeTax: false, offer: expired });
      expect.unreachable();
    } catch (e) {
      expect((e as { code?: string }).code).toBe("BAD_REQUEST");
      expect((e as { details?: { reason?: string } }).details?.reason).toBe("EXPIRED");
    }
    const r = priceCart([cl()], { pricesIncludeTax: false, offer: expired, onInvalidOffer: "ignore" });
    expect(r.offer).toEqual({ applied: false, reason: "EXPIRED", discountMinor: 0 });
    expect(r.totalMinor).toBe(10000);
  });

  it("uses the supplied clock for validity", () => {
    const o = offer({ validFrom: new Date("2030-01-01") });
    expect(() => priceCart([cl()], { pricesIncludeTax: false, offer: o, now: new Date("2029-12-31") })).toThrow();
    expect(priceCart([cl()], { pricesIncludeTax: false, offer: o, now: new Date("2030-01-01") }).offerDiscountMinor).toBe(1000);
  });

  it("a coupon cannot push the total below zero", () => {
    const r = priceCart([cl({ unitPriceMinor: 500, taxBps: 1800 })], { pricesIncludeTax: false, offer: offer({ type: "FIXED", value: 100000 }) });
    expect(r.totalMinor).toBe(0);
    expect(r.taxMinor).toBe(0);
    expect(r.offerDiscountMinor).toBe(500);
  });

  it("rejects an empty cart, bad lines and absurd totals", () => {
    expect(() => priceCart([], { pricesIncludeTax: false })).toThrow(/empty/i);
    expect(() => priceCart([cl({ quantity: 0 })], { pricesIncludeTax: false })).toThrow();
    expect(() => priceCart([cl({ unitPriceMinor: -1 })], { pricesIncludeTax: false })).toThrow();
    expect(() => priceCart([cl({ unitPriceMinor: 10_000_000_00, quantity: 3 })], { pricesIncludeTax: false })).toThrow(/too large/i);
    expect(() => priceCart(Array.from({ length: 101 }, () => cl()), { pricesIncludeTax: false })).toThrow(/too many/i);
    expect(MAX_TOTAL_MINOR).toBeLessThan(2 ** 31);
  });

  it("holds the identities for a spread of generated carts", () => {
    let seed = 12345;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let i = 0; i < 300; i++) {
      const n = 1 + rnd(4);
      const lines: CartLineInput[] = Array.from({ length: n }, () => {
        const price = 1 + rnd(500000);
        const t = rnd(3);
        return cl({
          unitPriceMinor: price,
          quantity: 1 + rnd(5),
          taxBps: [0, 500, 1200, 1800, 2800][rnd(5)],
          discountType: t === 0 ? "NONE" : t === 1 ? "PERCENT" : "FIXED",
          discountValue: t === 1 ? rnd(10001) : t === 2 ? rnd(price + 1) : 0,
        });
      });
      const inclusive = rnd(2) === 1;
      const o = rnd(2) ? offer({ type: rnd(2) ? "PERCENT" : "FIXED", value: rnd(2) ? rnd(10001) : rnd(100000) }) : null;
      const bad = o && o.type === "PERCENT" && o.value > 10000;
      if (bad) continue;
      const r = priceCart(lines, { pricesIncludeTax: inclusive, offer: o, onInvalidOffer: "ignore" });
      expect(r.discountMinor).toBe(r.productDiscountMinor + r.offerDiscountMinor);
      expect(r.netMinor + r.taxMinor).toBe(r.totalMinor);
      expect(r.totalMinor).toBe(inclusive ? r.subtotalMinor - r.discountMinor : r.subtotalMinor - r.discountMinor + r.taxMinor);
      expect(r.totalMinor).toBeGreaterThanOrEqual(0);
      for (const l of r.lines) {
        expect(l.taxableMinor).toBeGreaterThanOrEqual(0);
        expect(l.totalMinor).toBe(inclusive ? l.taxableMinor : l.taxableMinor + l.taxMinor);
      }
    }
  });

  it("matches priceLine for a single line without a coupon", () => {
    const l = cl({ unitPriceMinor: 1999, quantity: 7, taxBps: 1800, discountType: "PERCENT", discountValue: 1250 });
    for (const inc of [false, true]) {
      const c = priceCart([l], { pricesIncludeTax: inc });
      const p = priceLine({ ...l, pricesIncludeTax: inc });
      expect(c.lines[0]).toEqual(p);
      expect(c.totalMinor).toBe(p.totalMinor);
    }
  });
});
