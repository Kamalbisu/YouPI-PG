export type Role = "SUPER_ADMIN" | "CLIENT";

export interface Actor {
  userId: string;
  email: string;
  name: string;
  role: Role;
  clientId: string | null;
  /** Granted client capabilities (SUPER_ADMIN implicitly has all). */
  permissions: string[];
  /** True when the user is an OWNER of at least one business (or the primary account holder). */
  isOwner: boolean;
  /** Business ids this user may access (client users only). */
  businessIds: string[];
  sessionId: string | null;
}

export interface Ctx {
  actor: Actor | null;
  ip: string | null;
  userAgent: string | null;
}

export const systemCtx = (): Ctx => ({ actor: null, ip: null, userAgent: null });
