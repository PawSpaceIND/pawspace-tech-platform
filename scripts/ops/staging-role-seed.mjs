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
const identities = [
  { id:'UAT-FOUNDER', email:'founder@pawspace.in', name:'PawSpace Founder', role:'founder' },
  { id:'UAT-FINANCE', email:'anjali.finance33@tkpetcare.in', name:'Anjali Finance', role:'finance' },
  { id:'UAT-MANAGER', email:'jyoti.manager39@tkpetcare.in', name:'Jyoti Manager', role:'manager' },
  { id:'UAT-GROOMER', email:'asha.groomer1@tkpetcare.in', name:'Asha Groomer', role:'service_provider' },
  { id:'UAT-ASSOCIATE', email:'anita.associate17@tkpetcare.in', name:'Anita Associate', role:'associate' },
];
const sql = [
  "CREATE TABLE IF NOT EXISTS role_definitions (code TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, permissions_json TEXT NOT NULL, system_role INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);",
  "CREATE TABLE IF NOT EXISTS app_users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role_code TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);",
  ...roles.map(role => `INSERT INTO role_definitions (code,name,description,permissions_json,system_role,updated_at) VALUES (${q(role.code)},${q(role.name)},${q(role.description)},${q(JSON.stringify(role.permissions))},1,${now}) ON CONFLICT(code) DO UPDATE SET name=excluded.name,description=excluded.description,permissions_json=excluded.permissions_json,system_role=1,updated_at=excluded.updated_at;`),
  ...identities.map(identity => `INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (${q(identity.id)},${q(identity.email)},${q(identity.name)},${q(identity.role)},'active',${now},${now}) ON CONFLICT(email) DO UPDATE SET name=excluded.name,role_code=excluded.role_code,status='active',updated_at=excluded.updated_at;`),
].join('\n') + '\n';
writeFileSync(out, sql, { encoding: 'utf8', mode: 0o600 });
console.log(`Wrote ${roles.length} staging UAT roles and ${identities.length} deterministic identities to ${out}`);
