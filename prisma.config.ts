import "dotenv/config";
import { defineConfig } from "prisma/config";

// Prisma 7 does not auto-load .env itself; `dotenv/config` above reads it.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: process.env.DATABASE_URL ?? "postgresql://localhost:5432/placeholder" },
});
