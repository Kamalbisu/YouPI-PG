import { z } from "zod";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { AppError, badRequest } from "@/lib/errors";
import { ALL_CLIENT_PERMISSIONS, DEFAULT_CLIENT_PERMISSIONS } from "@/lib/permissions";
import { parse } from "@/lib/validation";
import { requireAdmin } from "@/server/auth/guards";
import type { Ctx } from "@/server/auth/types";

const permissionList = z
  .array(z.enum(ALL_CLIENT_PERMISSIONS as [string, ...string[]]))
  .max(ALL_CLIENT_PERMISSIONS.length)
  .transform((a) => Array.from(new Set(a)));

/**
 * Typed registry of platform settings. Each key has a zod schema and a default, so
 * reads never fail on a missing row and writes are always validated.
 */
export const SETTINGS = {
  platformName: { schema: z.string().trim().min(2, "Too short").max(80), default: "YouPI PG" },
  supportEmail: {
    schema: z.union([z.literal(""), z.string().trim().toLowerCase().email("Enter a valid email").max(254)]),
    default: "",
  },
  maintenanceBanner: { schema: z.string().trim().max(300, "Keep it under 300 characters"), default: "" },
  defaultClientPermissions: { schema: permissionList, default: [...DEFAULT_CLIENT_PERMISSIONS] as string[] },
  allowClientSelfRegistration: { schema: z.boolean(), default: false },
  orderExpiryMinutes: { schema: z.number().int().min(5, "At least 5 minutes").max(1440, "At most 1440 minutes"), default: 30 },
  webhookRetentionDays: { schema: z.number().int().min(7, "At least 7 days").max(3650, "At most 3650 days"), default: 90 },
} as const;

export type SettingKey = keyof typeof SETTINGS;
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTINGS)[K]["schema"]>;
export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];

export const SETTING_GROUPS: { id: string; title: string; description: string; keys: SettingKey[] }[] = [
  { id: "general", title: "General", description: "Branding, support contact and the site-wide banner.", keys: ["platformName", "supportEmail", "maintenanceBanner"] },
  { id: "clients", title: "Clients", description: "Defaults applied to new client accounts.", keys: ["defaultClientPermissions", "allowClientSelfRegistration"] },
  { id: "operations", title: "Orders and webhooks", description: "How long unpaid orders stay open and how long webhook logs are kept.", keys: ["orderExpiryMinutes", "webhookRetentionDays"] },
];

function isKey(k: string): k is SettingKey {
  return Object.prototype.hasOwnProperty.call(SETTINGS, k);
}

/** Read one setting. Falls back to the default when unset or when the stored value is no longer valid. */
export async function getSetting<K extends SettingKey>(key: K): Promise<SettingValue<K>> {
  const def = SETTINGS[key];
  const row = await db.platformSetting.findUnique({ where: { key } });
  if (!row) return def.default as SettingValue<K>;
  const r = def.schema.safeParse(row.value);
  return (r.success ? r.data : def.default) as SettingValue<K>;
}

export async function getAllSettings(): Promise<{ [K in SettingKey]: SettingValue<K> }> {
  const rows = await db.platformSetting.findMany();
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const out: Record<string, unknown> = {};
  for (const k of SETTING_KEYS) {
    const def = SETTINGS[k];
    const r = byKey.has(k) ? def.schema.safeParse(byKey.get(k)) : null;
    out[k] = r && r.success ? r.data : def.default;
  }
  return out as { [K in SettingKey]: SettingValue<K> };
}

export async function getOrderExpiryMinutes(): Promise<number> {
  return getSetting("orderExpiryMinutes");
}

/** Validate and store one setting (admin only), with an audit record in the same transaction. */
export async function setSetting<K extends SettingKey>(ctx: Ctx, key: K, value: unknown): Promise<SettingValue<K>> {
  const actor = requireAdmin(ctx);
  if (!isKey(key)) throw badRequest("Unknown setting");
  const next = parse(SETTINGS[key].schema, value) as SettingValue<K>;
  const before = await getSetting(key);
  await db.$transaction(async (tx) => {
    await tx.platformSetting.upsert({
      where: { key },
      create: { key, value: next as never, updatedById: actor.userId },
      update: { value: next as never, updatedById: actor.userId },
    });
    await audit(ctx, { action: "settings.update", entityType: "PlatformSetting", entityId: key, metadata: { setting: key, from: before, to: next } }, tx);
  });
  return next;
}

/** Update several settings at once (one form group). All values are validated before anything is written. */
export async function updateSettings(ctx: Ctx, raw: unknown) {
  const actor = requireAdmin(ctx);
  const input = parse(z.object({ values: z.record(z.string(), z.unknown()) }), raw).values;
  const entries = Object.entries(input);
  if (entries.length === 0) throw badRequest("Nothing to update");
  const clean: [SettingKey, unknown][] = [];
  const fields: Record<string, string> = {};
  for (const [k, v] of entries) {
    if (!isKey(k)) throw badRequest(`Unknown setting: ${k}`);
    const r = SETTINGS[k].schema.safeParse(v);
    if (!r.success) fields[k] = r.error.issues[0]?.message ?? "Invalid value";
    else clean.push([k, r.data]);
  }
  if (Object.keys(fields).length) throw new AppError("VALIDATION", Object.values(fields)[0], { fields });
  const before = await getAllSettings();
  await db.$transaction(async (tx) => {
    for (const [k, v] of clean) {
      if (JSON.stringify(before[k]) === JSON.stringify(v)) continue;
      await tx.platformSetting.upsert({
        where: { key: k },
        create: { key: k, value: v as never, updatedById: actor.userId },
        update: { value: v as never, updatedById: actor.userId },
      });
      await audit(ctx, { action: "settings.update", entityType: "PlatformSetting", entityId: k, metadata: { setting: k, from: before[k], to: v } }, tx);
    }
  });
  return getAllSettings();
}

/** Admin read of every setting with its default. */
export async function listSettings(ctx: Ctx) {
  requireAdmin(ctx);
  return getAllSettings();
}
