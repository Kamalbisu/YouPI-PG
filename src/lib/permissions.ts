/**
 * Capabilities a Super Admin can grant to a client account.
 * Business access (which businesses a user may touch) is separate and enforced by membership.
 */
export const CLIENT_PERMISSIONS = {
  "products.manage": "Create and edit products, services and categories",
  "offers.manage": "Create and edit offers and coupons",
  "qr.manage": "Generate, download and revoke QR codes",
  "payments.view": "View payments, transactions and refunds",
  "payments.refund": "Request refunds for paid orders",
  "reports.view": "View dashboards and reports",
  "reports.export": "Export CSV / PDF reports",
  "orders.manage": "Cancel unpaid orders and add order notes",
  "team.manage": "Invite and manage staff users",
  "support.use": "Raise and reply to support tickets",
  "settings.manage": "Edit business profile and settings",
} as const;

export type ClientPermission = keyof typeof CLIENT_PERMISSIONS;
export const ALL_CLIENT_PERMISSIONS = Object.keys(CLIENT_PERMISSIONS) as ClientPermission[];

export const DEFAULT_CLIENT_PERMISSIONS: ClientPermission[] = [
  "products.manage",
  "offers.manage",
  "qr.manage",
  "payments.view",
  "reports.view",
  "reports.export",
  "orders.manage",
  "support.use",
  "settings.manage",
];

export function isClientPermission(s: string): s is ClientPermission {
  return s in CLIENT_PERMISSIONS;
}
