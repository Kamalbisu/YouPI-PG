import argon2, { type HashOptions } from "argon2";

const OPTS: HashOptions = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };

export const hashPassword = (plain: string) => argon2.hash(plain, OPTS);

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

let dummy: Promise<string> | null = null;
/** Verify against a throwaway hash so unknown emails take the same time as wrong passwords. */
export async function burnPasswordCheck(plain: string) {
  dummy ??= hashPassword("not-a-real-password-" + Math.random());
  await verifyPassword(await dummy, plain);
}
