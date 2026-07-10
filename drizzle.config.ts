import { defineConfig } from 'drizzle-kit'

// SQLite / Cloudflare D1. `drizzle-kit generate` needs no credentials — it only
// diffs the schema and writes migration SQL to ./migrations. The host app's
// `wrangler d1 migrations apply` (pointed at this dir via `migrations_dir`)
// runs them against its D1. Tables are prefixed `wf_` and use opaque tenancy
// columns so the SDK's schema can coexist with any host schema.
export default defineConfig({
  schema: './src/storage/schema.ts',
  out: './migrations',
  dialect: 'sqlite',
})
