export type Role = "ADMIN" | "USER" | "AUDITOR";

export interface Actor {
  userId: string;
  role: Role;
  name: string;
  username: string;
  sessionId: string | null;
}

export interface Ctx {
  actor: Actor | null;
  ip: string | null;
  userAgent: string | null;
}

export const systemCtx = (): Ctx => ({ actor: null, ip: null, userAgent: null });
