export type Portal = "admin" | "client";

export const PROVIDER_LABEL: Record<string, string> = {
  RAZORPAY: "Razorpay",
  CASHFREE: "Cashfree",
  DEV_SIMULATOR: "Test simulator",
};

export const METHOD_LABEL: Record<string, string> = {
  upi_gpay: "Google Pay",
  upi_phonepe: "PhonePe",
  upi_paytm: "Paytm",
  upi_other: "Other UPI app",
  checkout: "Card, netbanking, wallets",
  simulator: "Test payment",
};

export const methodLabel = (m: string | null | undefined) => (m ? (METHOD_LABEL[m] ?? m) : "-");
export const providerLabel = (p: string | null | undefined) => (p ? (PROVIDER_LABEL[p] ?? p) : "-");

export const TXN_STATUS_OPTIONS = [
  { value: "SUCCEEDED", label: "Paid" },
  { value: "PARTIALLY_REFUNDED", label: "Partially refunded" },
  { value: "REFUNDED", label: "Refunded" },
];

export const ORDER_STATUS_OPTIONS = [
  { value: "PENDING_PAYMENT", label: "Awaiting payment" },
  { value: "PAID", label: "Paid" },
  { value: "PARTIALLY_REFUNDED", label: "Partially refunded" },
  { value: "REFUNDED", label: "Refunded" },
  { value: "CANCELLED", label: "Cancelled" },
  { value: "EXPIRED", label: "Expired" },
];

export const PROVIDER_OPTIONS = [
  { value: "RAZORPAY", label: "Razorpay" },
  { value: "CASHFREE", label: "Cashfree" },
  { value: "DEV_SIMULATOR", label: "Test simulator" },
];

export const METHOD_OPTIONS = Object.entries(METHOD_LABEL).map(([value, label]) => ({ value, label }));
