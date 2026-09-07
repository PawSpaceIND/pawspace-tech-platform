import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./drizzle",
  schema: ["./db/schema.ts", "./db/schema-escrow-attribution.ts"],
  dialect: "sqlite",
});
