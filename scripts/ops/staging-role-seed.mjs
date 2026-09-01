import { writeFileSync } from 'node:fs';
import { defaultRoles } from '../../lib/platform-security.ts';

const out = process.argv[2] || 'staging-role-seed.sql';
const q = value => `'${String(value).replaceAll("'", "''")}'`;
const now = Date.now();
const required = new Set(['founder','finance','manager','service_provider','associate']);
const roles = defaultRoles.filter(role => required.has(role.code));
if (roles.length !== required.size) {
  const found = new Set(roles.map(role => role.code));
  const missing = [...required].filter(code => !found.has(code));
  throw new Error(`missing required staging role definitions: ${missing.join(', ')}`);
}
const sql = [
  "CREATE TABLE IF NOT EXISTS role_definitions (code TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, permissions_json TEXT NOT NULL, system_role INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);",
  ...roles.map(role => `INSERT INTO role_definitions (code,name,description,permissions_json,system_role,updated_at) VALUES (${q(role.code)},${q(role.name)},${q(role.description)},${q(JSON.stringify(role.permissions))},1,${now}) ON CONFLICT(code) DO UPDATE SET name=excluded.name,description=excluded.description,permissions_json=excluded.permissions_json,system_role=1,updated_at=excluded.updated_at;`),
].join('\n') + '\n';
writeFileSync(out, sql, { encoding: 'utf8', mode: 0o600 });
console.log(`Wrote ${roles.length} staging UAT role definitions to ${out}`);
