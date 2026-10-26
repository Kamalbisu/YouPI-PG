import { afterAll } from "vitest";
import { disconnectDb } from "@/lib/db";

afterAll(async () => {
  await disconnectDb();
});
