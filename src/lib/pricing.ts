/**
 * Pure pricing functions. No I/O, no clock reads except the optional `now` argument.
 * All amounts are integers in minor units (paise). No floating point is used for money.
 *
 * Rules (the payments service relies on these, keep the doc and the tests in sync):
 *
 * 1. Per line: gross = unitPriceMinor * quantity.
 * 2. Product discount (per line, applied BEFORE tax and BEFORE any coupon):
 *      PERCENT: round-half-up(gross * bps / 10000)
 *      FIXED:   discountValue per unit (must be <= unit price) * quantity
 *    The discount can never exceed the line gross.
 * 3. Coupon (offer) applies to the cart amount after product discounts (`cartBase`).
 *    The offer's minimum order is compared against `cartBase`. PERCENT is round-half-up of
 *    cartBase * bps / 10000 and capped by maxDiscountMinor; FIXED is capped at cartBase.
 *    The coupon discount is split across lines in proportion to each line's amount after
 *    product discount, using the largest remainder method (ties go to the earlier line),
 *    so line amounts always add up exactly to the cart total.
 * 4. Tax is computed per line on the discounted amount and rounded half up per line. The cart tax
 *    is the sum of the line taxes.
 *      Exclusive prices (pricesIncludeTax = false): tax = round-half-up(taxable * bps / 10000),
 *        total = taxable + tax.
 *      Inclusive prices (pricesIncludeTax = true): the listed price already contains tax, so the tax
 *        is extracted: tax = round-half-up(taxable * bps / (10000 + bps)) and total = taxable.
 * 5. Identities that always hold (asserted in tests):
 *      subtotalMinor        = sum of listed prices * quantity (tax-inclusive when prices include tax)
 *      discountMinor        = productDiscountMinor + offerDiscountMinor
 *      netMinor             = subtotalMinor - discountMinor - (inclusive ? taxMinor : 0)   (value excluding tax)
 *      totalMinor           = netMinor + taxMinor
 *    For inclusive pricing: totalMinor = subtotalMinor - discountMinor.
 *    For exclusive pricing: totalMinor = subtotalMinor - discountMinor + taxMinor.
 *
 * Invalid input (non-integers, zero or negative price, quantity outside 1..MAX_QUANTITY, discount
 * out of range, a total above MAX_TOTAL_MINOR) throws an AppError (BAD_REQUEST).
 */
import { badRequest } from "./errors";

export const MAX_UNIT_PRICE_MINOR = 10_000_000_00; // 1 crore rupees
export const MAX_QUANTITY = 999;
/** Orders are stored in 32 bit integer columns; stay safely below 2^31 - 1. */
export const MAX_TOTAL_MINOR = 2_000_000_000;

export type DiscountKind = "NONE" | "PERCENT" | "FIXED";

export interface LineInput {
  unitPriceMinor: number;
  quantity: number;
  /** Tax rate in basis points (1800 = 18%). */
  taxBps: number;
  discountType: DiscountKind;
  /** Basis points for PERCENT, minor units per unit for FIXED. Ignored for NONE. */
  discountValue: number;
  pricesIncludeTax: boolean;
}

export interface LinePricing {
  unitPriceMinor: number;
  quantity: number;
  taxBps: number;
  /** unitPriceMinor * quantity (tax-inclusive when prices include tax). */
  grossMinor: number;
  /** Product level discount. */
  discountMinor: number;
  /** Share of the coupon discount allocated to this line (0 for priceLine). */
  offerDiscountMinor: number;
  /** Amount after all discounts (still includes tax when prices include tax). */
  taxableMinor: number;
  taxMinor: number;
  /** Line value excluding tax. */
  netMinor: number;
  /** What the customer pays for this line. */
  totalMinor: number;
}

// ---------- integer helpers ----------

function assertInt(n: unknown, what: string): asserts n is number {
  if (typeof n !== "number" || !Number.isInteger(n)) throw badRequest(`${what} must be a whole number`);
}

/** round-half-up(a * b / c) for non-negative integers, overflow safe. */
export function mulDivRound(a: number, b: number, c: number): number {
  if (c <= 0) throw badRequest("Division by zero");
  const num = BigInt(a) * BigInt(b);
  const den = BigInt(c);
  return Number((num * 2n + den) / (2n * den));
}

/** Round half up percentage of an amount in basis points. */
export function percentOf(amountMinor: number, bps: number): number {
  return mulDivRound(amountMinor, bps, 10000);
}

/** Tax contained in a tax-inclusive amount. */
export function extractTax(inclusiveMinor: number, bps: number): number {
  return mulDivRound(inclusiveMinor, bps, 10000 + bps);
}

function validateLine(l: LineInput) {
  assertInt(l.unitPriceMinor, "Price");
  assertInt(l.quantity, "Quantity");
  assertInt(l.taxBps, "Tax rate");
  assertInt(l.discountValue, "Discount");
  if (l.unitPriceMinor < 1 || l.unitPriceMinor > MAX_UNIT_PRICE_MINOR) throw badRequest("Price is out of range");
  if (l.quantity < 1 || l.quantity > MAX_QUANTITY) throw badRequest(`Quantity must be between 1 and ${MAX_QUANTITY}`);
  if (l.taxBps < 0 || l.taxBps > 10000) throw badRequest("Tax rate must be between 0% and 100%");
  if (l.discountType !== "NONE" && l.discountType !== "PERCENT" && l.discountType !== "FIXED") throw badRequest("Unknown discount type");
  if (l.discountType === "PERCENT" && (l.discountValue < 0 || l.discountValue > 10000)) throw badRequest("Percent discount must be between 0% and 100%");
  if (l.discountType === "FIXED" && (l.discountValue < 0 || l.discountValue > l.unitPriceMinor)) throw badRequest("Fixed discount cannot exceed the price");
}

/** Product level discount for a whole line. */
function lineDiscount(l: LineInput, gross: number): number {
  let d = 0;
  if (l.discountType === "PERCENT") d = percentOf(gross, l.discountValue);
  else if (l.discountType === "FIXED") d = l.discountValue * l.quantity;
  return Math.min(Math.max(d, 0), gross);
}

function finishLine(l: LineInput, gross: number, productDiscount: number, offerDiscount: number): LinePricing {
  const taxable = gross - productDiscount - offerDiscount;
  const inclusive = l.pricesIncludeTax;
  const tax = inclusive ? extractTax(taxable, l.taxBps) : percentOf(taxable, l.taxBps);
  return {
    unitPriceMinor: l.unitPriceMinor,
    quantity: l.quantity,
    taxBps: l.taxBps,
    grossMinor: gross,
    discountMinor: productDiscount,
    offerDiscountMinor: offerDiscount,
    taxableMinor: taxable,
    taxMinor: tax,
    netMinor: inclusive ? taxable - tax : taxable,
    totalMinor: inclusive ? taxable : taxable + tax,
  };
}

/** Price one line (no coupon). */
export function priceLine(input: LineInput): LinePricing {
  validateLine(input);
  const gross = input.unitPriceMinor * input.quantity;
  const out = finishLine(input, gross, lineDiscount(input, gross), 0);
  if (out.totalMinor > MAX_TOTAL_MINOR) throw badRequest("Amount is too large");
  return out;
}

/** Unit price after the product's own discount, for catalogue display (not used for billing). */
export function unitPriceAfterDiscount(p: { priceMinor: number; discountType: DiscountKind; discountValue: number }): number {
  if (p.discountType === "PERCENT") return p.priceMinor - percentOf(p.priceMinor, p.discountValue);
  if (p.discountType === "FIXED") return Math.max(1, p.priceMinor - p.discountValue);
  return p.priceMinor;
}

/** Tax rate for a product: its own override, otherwise the business default. */
export function effectiveTaxBps(product: { taxBps: number | null }, business: { defaultTaxBps: number }): number {
  return product.taxBps ?? business.defaultTaxBps;
}

// ---------- offers ----------

export interface OfferRule {
  type: "PERCENT" | "FIXED";
  /** Basis points for PERCENT, minor units for FIXED. */
  value: number;
  minOrderMinor: number;
  maxDiscountMinor: number | null;
  validFrom: Date | null;
  validTo: Date | null;
  usageLimit: number | null;
  usedCount: number;
  isActive: boolean;
}

export type OfferRejection = "INACTIVE" | "NOT_STARTED" | "EXPIRED" | "USAGE_LIMIT" | "MIN_ORDER" | "INVALID";

export type OfferResult = { ok: true; discountMinor: number } | { ok: false; reason: OfferRejection };

export const OFFER_REJECTION_MESSAGE: Record<OfferRejection, string> = {
  INACTIVE: "This coupon is not active",
  NOT_STARTED: "This coupon is not valid yet",
  EXPIRED: "This coupon has expired",
  USAGE_LIMIT: "This coupon has reached its usage limit",
  MIN_ORDER: "The order amount is below the minimum for this coupon",
  INVALID: "This coupon is not valid",
};

/**
 * Evaluate an offer against the cart amount (after product discounts, before tax for exclusive
 * pricing). Validity window is inclusive on both ends. Returns the discount or the reason it
 * cannot be used. The discount never exceeds `baseMinor`.
 */
export function applyOffer(offer: OfferRule, baseMinor: number, now: Date = new Date()): OfferResult {
  if (!Number.isInteger(baseMinor) || baseMinor < 0) return { ok: false, reason: "INVALID" };
  if (!Number.isInteger(offer.value) || offer.value < 0) return { ok: false, reason: "INVALID" };
  if (offer.type === "PERCENT" && offer.value > 10000) return { ok: false, reason: "INVALID" };
  if (!offer.isActive) return { ok: false, reason: "INACTIVE" };
  if (offer.validFrom && now.getTime() < offer.validFrom.getTime()) return { ok: false, reason: "NOT_STARTED" };
  if (offer.validTo && now.getTime() > offer.validTo.getTime()) return { ok: false, reason: "EXPIRED" };
  if (offer.usageLimit != null && offer.usedCount >= offer.usageLimit) return { ok: false, reason: "USAGE_LIMIT" };
  if (baseMinor < offer.minOrderMinor) return { ok: false, reason: "MIN_ORDER" };
  let d = offer.type === "PERCENT" ? percentOf(baseMinor, offer.value) : offer.value;
  if (offer.maxDiscountMinor != null) d = Math.min(d, offer.maxDiscountMinor);
  d = Math.min(d, baseMinor);
  return { ok: true, discountMinor: d };
}

/** Split `total` across weights using the largest remainder method; ties go to the earlier index. */
export function allocateProportionally(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (total <= 0 || sum <= 0) return weights.map(() => 0);
  const base = weights.map((w) => Math.floor(Number((BigInt(total) * BigInt(w)) / BigInt(sum))));
  let left = total - base.reduce((a, b) => a + b, 0);
  const rem = weights
    .map((w, i) => ({ i, r: Number((BigInt(total) * BigInt(w)) % BigInt(sum)) }))
    .sort((a, b) => b.r - a.r || a.i - b.i);
  for (const { i } of rem) {
    if (left <= 0) break;
    if (base[i] < weights[i]) {
      base[i] += 1;
      left -= 1;
    }
  }
  return base;
}

// ---------- cart ----------

export type CartLineInput = Omit<LineInput, "pricesIncludeTax">;

export interface CartOptions {
  pricesIncludeTax: boolean;
  offer?: OfferRule | null;
  now?: Date;
  /** What to do when the offer cannot be applied: throw a BAD_REQUEST (default) or price without it. */
  onInvalidOffer?: "throw" | "ignore";
}

export interface CartPricing {
  lines: LinePricing[];
  pricesIncludeTax: boolean;
  subtotalMinor: number;
  productDiscountMinor: number;
  offerDiscountMinor: number;
  /** productDiscountMinor + offerDiscountMinor */
  discountMinor: number;
  taxMinor: number;
  /** Value excluding tax, after discounts. */
  netMinor: number;
  totalMinor: number;
  /** Present when an offer was supplied. */
  offer: { applied: boolean; reason?: OfferRejection; discountMinor: number } | null;
}

export function priceCart(lines: CartLineInput[], opts: CartOptions): CartPricing {
  if (!Array.isArray(lines) || lines.length === 0) throw badRequest("The cart is empty");
  if (lines.length > 100) throw badRequest("Too many items in the cart");
  const full: LineInput[] = lines.map((l) => ({ ...l, pricesIncludeTax: opts.pricesIncludeTax }));
  full.forEach(validateLine);

  const gross = full.map((l) => l.unitPriceMinor * l.quantity);
  const prod = full.map((l, i) => lineDiscount(l, gross[i]));
  const afterProduct = gross.map((g, i) => g - prod[i]);
  const cartBase = afterProduct.reduce((a, b) => a + b, 0);

  let offerDiscount = 0;
  let offerInfo: CartPricing["offer"] = null;
  if (opts.offer) {
    const r = applyOffer(opts.offer, cartBase, opts.now ?? new Date());
    if (r.ok) {
      offerDiscount = r.discountMinor;
      offerInfo = { applied: true, discountMinor: r.discountMinor };
    } else {
      if ((opts.onInvalidOffer ?? "throw") === "throw") throw badRequest(OFFER_REJECTION_MESSAGE[r.reason], { reason: r.reason });
      offerInfo = { applied: false, reason: r.reason, discountMinor: 0 };
    }
  }
  const alloc = allocateProportionally(offerDiscount, afterProduct);
  const priced = full.map((l, i) => finishLine(l, gross[i], prod[i], alloc[i]));

  const sum = (f: (l: LinePricing) => number) => priced.reduce((a, l) => a + f(l), 0);
  const out: CartPricing = {
    lines: priced,
    pricesIncludeTax: opts.pricesIncludeTax,
    subtotalMinor: sum((l) => l.grossMinor),
    productDiscountMinor: sum((l) => l.discountMinor),
    offerDiscountMinor: sum((l) => l.offerDiscountMinor),
    discountMinor: sum((l) => l.discountMinor + l.offerDiscountMinor),
    taxMinor: sum((l) => l.taxMinor),
    netMinor: sum((l) => l.netMinor),
    totalMinor: sum((l) => l.totalMinor),
    offer: offerInfo,
  };
  if (out.totalMinor > MAX_TOTAL_MINOR) throw badRequest("Order amount is too large");
  return out;
}
