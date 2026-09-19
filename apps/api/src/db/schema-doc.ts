/**
 * Writes a readable schema reference, including the row-level security.
 *
 * A browser client (Adminer, on port 8081) shows tables, columns and indexes
 * perfectly well. It does not show POLICIES — and in this schema the policies
 * are the design. "Which columns does `student` have" is a much less useful
 * question here than "who can see a row of it, and which columns can they
 * read", and no general-purpose database UI answers the second one.
 *
 * So this is not a replacement for a database client, it is the half a database
 * client cannot give you. Regenerated from the live database rather than
 * written by hand, for the same reason the OpenAPI spec is.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadDotenv } from '../config/load-dotenv.ts';

loadDotenv();
const { loadEnv } = await import('../config/env.ts');
const env = loadEnv();

interface Column {
  table_name: string; column_name: string; data_type: string;
  is_nullable: string; column_default: string | null;
}
interface Policy {
  tablename: string; policyname: string; cmd: string;
  roles: string[]; qual: string | null; with_check: string | null;
}
interface Grant {
  table_name: string; grantee: string; privilege_type: string;
  column_name: string | null;
}
interface Rls { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }

const out = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'SCHEMA.md');

const client = new pg.Client({ connectionString: env.DATABASE_OWNER_URL });
await client.connect();

const { rows: tables } = await client.query<Rls>(
  `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY c.relname`);

const { rows: columns } = await client.query<Column>(
  `SELECT table_name, column_name, data_type, is_nullable, column_default
     FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, ordinal_position`);

const { rows: policies } = await client.query<Policy>(
  `SELECT tablename, policyname, cmd, roles::text[], qual, with_check
     FROM pg_policies WHERE schemaname = 'public'
    ORDER BY tablename, policyname`);

// Column-level grants matter here: `student` deliberately has none on its
// RESTRICTED columns for the application role, and that is invisible in any
// table-level view.
const { rows: grants } = await client.query<Grant>(
  `SELECT table_name, grantee, privilege_type, NULL::text AS column_name
     FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND grantee LIKE 'paathshala%'
   UNION ALL
   SELECT table_name, grantee, privilege_type, column_name
     FROM information_schema.column_privileges
    WHERE table_schema = 'public' AND grantee LIKE 'paathshala%'
    ORDER BY table_name, grantee, privilege_type`);

const { rows: functions } = await client.query<{
  proname: string; prosecdef: boolean; description: string | null;
}>(
  `SELECT p.proname, p.prosecdef, obj_description(p.oid, 'pg_proc') AS description
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname LIKE 'app\\_%'
    ORDER BY p.proname`);

await client.end();

const by = <T, K extends string>(rows: T[], key: (r: T) => K): Map<K, T[]> => {
  const map = new Map<K, T[]>();
  for (const row of rows) {
    const k = key(row);
    map.set(k, [...(map.get(k) ?? []), row]);
  }
  return map;
};

const columnsByTable = by(columns, (c) => c.table_name);
const policiesByTable = by(policies, (p) => p.tablename);
const grantsByTable = by(grants, (g) => g.table_name);

const lines: string[] = [
  '# Database schema',
  '',
  '_Generated from the live database by `pnpm db:schema`. Do not edit._',
  '',
  'A browser client shows tables and columns; this exists for the part it cannot',
  'show. Nearly every table here carries row-level security, and the policies are',
  'the actual design — "who can see a row" matters far more in this schema than',
  '"which columns exist".',
  '',
  `Tables: **${tables.length}** · policies: **${policies.length}** · `
    + `\`app_*\` helper functions: **${functions.length}**`,
  '',
  '## The scope helpers',
  '',
  'Policies are written in terms of these. A function marked **definer** runs as',
  'its owner so that its own reads are plain queries rather than nested policy',
  'evaluations — which is what keeps two policies that read each other from',
  'recursing.',
  '',
  '| Function | | What it answers |',
  '| --- | --- | --- |',
];

for (const fn of functions) {
  const note = (fn.description ?? '').replace(/\s+/g, ' ').trim();
  lines.push(`| \`${fn.proname}()\` | ${fn.prosecdef ? '**definer**' : ''} | ${note} |`);
}

lines.push('', '## Tables', '');

for (const table of tables) {
  const cols = columnsByTable.get(table.relname) ?? [];
  const pols = policiesByTable.get(table.relname) ?? [];
  const grs = grantsByTable.get(table.relname) ?? [];

  lines.push(`### \`${table.relname}\``, '');

  if (table.relrowsecurity) {
    lines.push(
      `Row-level security: **enabled**${table.relforcerowsecurity ? ', **forced**' : ''}`
      + `${table.relforcerowsecurity ? ' (applies to the table owner too)' : ''}`, '');
  } else {
    lines.push('Row-level security: **not enabled**', '');
  }

  lines.push('| Column | Type | Null |', '| --- | --- | --- |');
  for (const c of cols) {
    lines.push(`| ${c.column_name} | ${c.data_type} | ${c.is_nullable === 'YES' ? 'yes' : ''} |`);
  }
  lines.push('');

  // Only shown where they are narrower than the table, which is the case worth
  // seeing — a column list here means somebody deliberately withheld the rest.
  const columnGrants = grs.filter((g) => g.column_name !== null);
  const byGrantee = by(columnGrants, (g) => `${g.grantee}:${g.privilege_type}`);
  const narrowed = [...byGrantee.entries()].filter(([, gs]) => gs.length < cols.length);
  if (narrowed.length > 0) {
    lines.push('Column-level grants (narrower than the table):', '');
    for (const [k, gs] of narrowed) {
      const [grantee, privilege] = k.split(':');
      lines.push(`- \`${grantee}\` may **${privilege?.toLowerCase()}** only: `
        + gs.map((g) => `\`${g.column_name}\``).join(', '));
    }
    lines.push('');
  }

  for (const policy of pols) {
    lines.push(`**Policy \`${policy.policyname}\`** — ${policy.cmd} to `
      + `${policy.roles.join(', ')}`, '');
    if (policy.qual) lines.push('```sql', `USING ${policy.qual}`, '```', '');
    if (policy.with_check) lines.push('```sql', `WITH CHECK ${policy.with_check}`, '```', '');
  }
}

writeFileSync(out, `${lines.join('\n')}\n`);
console.log(`wrote ${out} — ${tables.length} tables, ${policies.length} policies`);
