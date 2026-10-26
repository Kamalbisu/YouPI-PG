import { createCashfree } from "./cashfree";
import { createRazorpay } from "./razorpay";
import { simulator } from "./simulator";
import type { FetchImpl, PaymentProvider, ProviderId } from "./types";

export * from "./types";
export { simulator, SIMULATOR_SIGNATURE_HEADER, signSimulatorBody, simulatorSecret, assertSimulator } from "./simulator";

/** Test seam: route all provider HTTP through a mock. Pass null to restore the real fetch. */
let fetchOverride: FetchImpl | null = null;
export function setProviderFetch(fn: FetchImpl | null) {
  fetchOverride = fn;
}
const getFetch = (): FetchImpl => fetchOverride ?? ((input, init) => fetch(input, init));

const razorpay = createRazorpay(getFetch);
const cashfree = createCashfree(getFetch);

export function getProvider(id: ProviderId): PaymentProvider {
  switch (id) {
    case "RAZORPAY":
      return razorpay;
    case "CASHFREE":
      return cashfree;
    case "DEV_SIMULATOR":
      return simulator;
  }
}
