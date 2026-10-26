export type Portal = "admin" | "client";
export type QrType = "BUSINESS" | "PRODUCT" | "ORDER" | "DYNAMIC_PAYMENT";
export type QrDisplayState = "active" | "revoked" | "expired";

export const QR_TYPE_LABEL: Record<QrType, string> = {
  BUSINESS: "Business",
  PRODUCT: "Product",
  ORDER: "Order",
  DYNAMIC_PAYMENT: "Payment",
};

export function qrState(q: { status: string; expiresAt: Date | string | null }, now = Date.now()): QrDisplayState {
  if (q.status === "REVOKED") return "revoked";
  if (q.expiresAt && new Date(q.expiresAt).getTime() <= now) return "expired";
  return "active";
}

export const QR_STATE_TONE: Record<QrDisplayState, "green" | "red" | "amber"> = { active: "green", revoked: "red", expired: "amber" };
export const QR_STATE_LABEL: Record<QrDisplayState, string> = { active: "Active", revoked: "Revoked", expired: "Expired" };

export interface BusinessOption {
  id: string;
  name: string;
}
