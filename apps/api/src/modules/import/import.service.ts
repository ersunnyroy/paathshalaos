/**
 * M9.4 and M9.5 — upload → map → validate → preview → apply → reverse.
 *
 * **AC-9:** 5,000 rows with 12 defects — nothing written during validation, and
 * the preview matches the apply exactly.
 *
 * The two guarantees are mechanical, not aspirational:
 *
 *   **Nothing written during validation.** `validate()` touches `import_row` and
 *   nothing else. It is not "careful not to write"; there is no code path from
 *   it to a domain table. The half-applied import — 3,000 learners in, one bad
 *   row, nobody knows what state the school is in — is the failure that loses a
 *   customer in week one.
 *
 *   **Preview matches apply.** The preview records a plan per row and a DIGEST
 *   of everything it read. The apply re-derives that digest and refuses on a
 *   mismatch. So "it said 4,988 and created 4,991" is not rare, it is
 *   impossible: the only ways to get a different number are a different plan
 *   (refused) or a bug in one shared code path (which both would share).
 *
 * Reversal is the third property and has its own rule: it refuses rather than
 * cascades. An undo that deletes a learner who has since been marked present,
 * invoiced and graded is a second disaster, not a recovery.
 */
import { createHash } from 'node:crypto';
import { withTenant, type TenantScope, type TenantClient } from '../../db/tenant.ts';
import { ApiError } from '../../common/errors.ts';
import { auditService } from '../audit/audit.service.ts';

export type ImportEntity = 'learner_roster' | 'staff_roster' | 'guardian_link' | 'fee_assignment';
export type Transform = 'trim' | 'upper' | 'lower' | 'date_dmy' | 'date_ymd'
  | 'phone_in' | 'digits_only';

export interface Mapping {
  sourceColumn: string;
  targetField: string;
  transform?: Transform;
  isRequired?: boolean;
  defaultValue?: string;
}

export interface RowError { field: string; code: string; message: string }

export interface PreviewCounts {
  total: number; create: number; update: number; skip: number; invalid: number;
}

/**
 * The fields each entity accepts. A closed list per entity, because a generic
 * "map any column to any field" importer is how a typo writes to the ledger.
 */
const FIELDS: Record<ImportEntity, { required: string[]; optional: string[]; key: string }> = {
  learner_roster: {
    key: 'admission_no',
    required: ['admission_no', 'given_name'],
    optional: ['family_name', 'date_of_birth', 'gender', 'guardian_name', 'guardian_phone'],
  },
  staff_roster: {
    key: 'employee_code',
    required: ['employee_code', 'given_name'],
    optional: ['family_name', 'designation', 'joined_on', 'phone'],
  },
  guardian_link: {
    key: 'admission_no',
    required: ['admission_no', 'guardian_name'],
    optional: ['guardian_phone', 'relationship'],
  },
  fee_assignment: {
    key: 'admission_no',
    required: ['admission_no', 'fee_plan_code'],
    optional: [],
  },
};

export const importService = {
  async createBatch(
    scope: TenantScope,
    input: {
      entity: ImportEntity; originalFilename?: string; campusId?: string;
      uploadedByStaffId?: string; sourceSha256?: string;
    },
  ): Promise<{ id: string }> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO import_batch
           (tenant_id, campus_id, entity, original_filename, source_sha256, uploaded_by)
         VALUES (app_current_tenant_id(), $1::uuid, $2, $3::text, $4::text, $5::uuid)
         RETURNING id`,
        [input.campusId ?? null, input.entity, input.originalFilename ?? null,
         input.sourceSha256 ?? null, input.uploadedByStaffId ?? null],
      );
      return { id: rows[0]!.id };
    });
  },

  /**
   * Stores the raw rows exactly as they came out of the file.
   *
   * Untouched, on purpose: when somebody asks why a learner's name is wrong, the
   * answer has to start from what they actually uploaded, not from what the
   * parser made of it.
   */
  async stageRows(
    scope: TenantScope,
    input: { batchId: string; rows: Array<Record<string, string>> },
  ): Promise<{ staged: number }> {
    if (input.rows.length === 0) {
      throw ApiError.make('validation_error', 'no_rows', 'The file has no rows.');
    }
    return withTenant(scope, async (db) => {
      await assertStatus(db, input.batchId, ['uploaded', 'mapped']);
      // One statement rather than a loop: 5,000 round trips is a minute of a
      // person watching a spinner.
      await db.query(
        `INSERT INTO import_row (tenant_id, import_batch_id, row_no, raw)
         SELECT app_current_tenant_id(), $1::uuid, ordinality::integer, value
           FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY
         ON CONFLICT (import_batch_id, row_no) DO NOTHING`,
        [input.batchId, JSON.stringify(input.rows)],
      );
      return { staged: input.rows.length };
    });
  },

  async setMapping(
    scope: TenantScope,
    input: { batchId: string; mappings: Mapping[] },
  ): Promise<void> {
    await withTenant(scope, async (db) => {
      const batch = await assertStatus(db, input.batchId, ['uploaded', 'mapped']);
      const spec = FIELDS[batch.entity];

      const targets = new Set(input.mappings.map((m) => m.targetField));
      const unknown = [...targets].filter(
        (t) => !spec.required.includes(t) && !spec.optional.includes(t));
      if (unknown.length > 0) {
        throw ApiError.make('validation_error', 'unknown_field',
          `Not fields of ${batch.entity}: ${unknown.sort().join(', ')}.`);
      }
      const missing = spec.required.filter((f) => !targets.has(f));
      if (missing.length > 0) {
        // Refused here rather than producing 5,000 identical row errors, which
        // is a wall of red that hides the one actual problem.
        throw ApiError.make('validation_error', 'unmapped_required_field',
          `These are required and unmapped: ${missing.join(', ')}.`);
      }

      await db.query('DELETE FROM import_mapping WHERE import_batch_id = $1::uuid',
        [input.batchId]);
      for (const m of input.mappings) {
        await db.query(
          `INSERT INTO import_mapping
             (tenant_id, import_batch_id, source_column, target_field, transform,
              is_required, default_value)
           VALUES (app_current_tenant_id(), $1::uuid, $2, $3, $4::text, $5, $6::text)`,
          [input.batchId, m.sourceColumn, m.targetField, m.transform ?? null,
           m.isRequired ?? spec.required.includes(m.targetField), m.defaultValue ?? null],
        );
      }
      await db.query(
        `UPDATE import_batch SET status = 'mapped' WHERE id = $1::uuid AND status = 'uploaded'`,
        [input.batchId],
      );
    });
  },

  /**
   * Normalises and checks every row. Writes to `import_row` and NOTHING else.
   *
   * There is no path from here to a domain table — not a conditional one, not a
   * "only for valid rows" one. That is the guarantee, and it is worth more than
   * the convenience of writing the good rows early.
   */
  async validate(
    scope: TenantScope, batchId: string,
  ): Promise<{ valid: number; invalid: number; duplicate: number }> {
    const result = await withTenant(scope, async (db) => {
      const batch = await assertStatus(db, batchId,
        ['mapped', 'validated', 'previewed']);
      const spec = FIELDS[batch.entity];

      const mappings = await db.query<{
        source_column: string; target_field: string; transform: Transform | null;
        is_required: boolean; default_value: string | null;
      }>(
        `SELECT source_column, target_field, transform, is_required, default_value
           FROM import_mapping WHERE import_batch_id = $1::uuid`,
        [batchId],
      );
      if (mappings.rows.length === 0) {
        throw ApiError.make('conflict', 'not_mapped', 'Map the columns first.');
      }

      const rows = await db.query<{ id: string; row_no: number; raw: Record<string, string> }>(
        'SELECT id, row_no, raw FROM import_row WHERE import_batch_id = $1::uuid ORDER BY row_no',
        [batchId],
      );

      const seenKeys = new Map<string, number>();
      let valid = 0; let invalid = 0; let duplicate = 0;

      for (const row of rows.rows) {
        const normalised: Record<string, string> = {};
        const errors: RowError[] = [];

        for (const m of mappings.rows) {
          const raw = row.raw[m.source_column] ?? m.default_value ?? '';
          const { value, error } = applyTransform(raw, m.transform);
          if (error) {
            errors.push({ field: m.target_field, code: error, message: messageFor(error, raw) });
            continue;
          }
          if (m.is_required && value === '') {
            errors.push({ field: m.target_field, code: 'required',
              message: `${m.target_field} is required and this row has no value.` });
            continue;
          }
          if (value !== '') normalised[m.target_field] = value;
        }

        // Duplicates WITHIN the file, which no database constraint catches
        // because the second row never gets written. A roster with the same
        // admission number twice is the single most common defect.
        let status: 'valid' | 'invalid' | 'duplicate' = errors.length > 0 ? 'invalid' : 'valid';
        const key = normalised[spec.key];
        if (status === 'valid' && key) {
          const firstSeen = seenKeys.get(key);
          if (firstSeen !== undefined) {
            status = 'duplicate';
            errors.push({ field: spec.key, code: 'duplicate_in_file',
              message: `${spec.key} ${key} also appears on row ${firstSeen}.` });
          } else {
            seenKeys.set(key, row.row_no);
          }
        }

        if (status === 'valid') valid += 1;
        else if (status === 'duplicate') duplicate += 1;
        else invalid += 1;

        await db.query(
          `UPDATE import_row
              SET normalised = $2::jsonb, status = $3, errors = $4::jsonb,
                  planned_action = NULL, matched_id = NULL, updated_at = now()
            WHERE id = $1::uuid`,
          [row.id, JSON.stringify(normalised), status, JSON.stringify(errors)],
        );
      }

      await db.query(
        `UPDATE import_batch SET status = 'validated', validated_at = now(),
                plan_digest = NULL, preview_counts = NULL
          WHERE id = $1::uuid`,
        [batchId],
      );

      return { valid, invalid, duplicate };
    });
    return result;
  },

  /**
   * Decides what each valid row would do, and records a digest of everything the
   * decision was based on.
   *
   * The digest is the mechanism behind "preview matches apply". It covers the
   * normalised values AND the existing keys that were matched against, so a
   * learner created by somebody else between preview and apply invalidates the
   * plan rather than silently turning a `create` into a duplicate-key error
   * halfway through.
   */
  async preview(
    scope: TenantScope, batchId: string,
  ): Promise<{ counts: PreviewCounts; digest: string }> {
    return withTenant(scope, async (db) => {
      const batch = await assertStatus(db, batchId, ['validated', 'previewed']);
      const plan = await buildPlan(db, batchId, batch.entity);

      for (const item of plan.items) {
        await db.query(
          `UPDATE import_row SET planned_action = $2, matched_id = $3::uuid, updated_at = now()
            WHERE id = $1::uuid`,
          [item.rowId, item.action, item.matchedId],
        );
      }

      await db.query(
        `UPDATE import_batch
            SET status = 'previewed', previewed_at = now(),
                plan_digest = $2, preview_counts = $3::jsonb
          WHERE id = $1::uuid`,
        [batchId, plan.digest, JSON.stringify(plan.counts)],
      );

      return { counts: plan.counts, digest: plan.digest };
    });
  },

  /**
   * Applies the previewed plan.
   *
   * The plan is rebuilt from the same inputs by the same function the preview
   * used, and its digest compared. A mismatch is refused — the office is told
   * the data moved and asked to preview again, which is a small annoyance
   * compared with an apply that quietly did something other than what was
   * approved.
   */
  async apply(
    scope: TenantScope,
    input: { batchId: string; appliedByStaffId: string },
  ): Promise<{ counts: PreviewCounts; created: number; updated: number }> {
    const outcome = await withTenant(scope, async (db) => {
      const batch = await assertStatus(db, input.batchId, ['previewed']);
      if (!batch.plan_digest) {
        throw ApiError.make('conflict', 'not_previewed',
          'Preview the import before applying it.');
      }

      // Same function, same inputs. If this disagrees with what was shown, the
      // inputs moved.
      const plan = await buildPlan(db, input.batchId, batch.entity);
      if (plan.digest !== batch.plan_digest) {
        throw ApiError.make('conflict', 'plan_changed',
          'The data changed since the preview. Preview again and check the numbers.');
      }

      await db.query(
        `UPDATE import_batch SET status = 'applying' WHERE id = $1::uuid`,
        [input.batchId],
      );

      let sequence = 0;
      let created = 0;
      let updated = 0;

      for (const item of plan.items) {
        if (item.action === 'skip') continue;
        const written = await applyOne(db, {
          batchId: input.batchId, entity: batch.entity, item,
        });
        for (const w of written) {
          sequence += 1;
          await db.query(
            `INSERT INTO import_applied_row
               (tenant_id, import_batch_id, import_row_id, target_table, target_id,
                action, before_values, sequence_no)
             VALUES (app_current_tenant_id(), $1::uuid, $2::uuid, $3, $4::uuid, $5,
                     $6::jsonb, $7::integer)`,
            [input.batchId, item.rowId, w.table, w.id, w.action,
             w.before ? JSON.stringify(w.before) : null, sequence],
          );
        }
        if (item.action === 'create') created += 1; else updated += 1;

        await db.query(
          `UPDATE import_row SET status = 'applied', updated_at = now() WHERE id = $1::uuid`,
          [item.rowId],
        );
      }

      const appliedCounts = { ...plan.counts, applied: created + updated };
      await db.query(
        `UPDATE import_batch
            SET status = 'applied', applied_at = now(), applied_by = $2::uuid,
                applied_counts = $3::jsonb
          WHERE id = $1::uuid`,
        [input.batchId, input.appliedByStaffId, JSON.stringify(appliedCounts)],
      );

      return { counts: plan.counts, created, updated };
    });

    await auditService.record({
      tenantId: scope.tenantId,
      actorUserId: scope.actorId,
      action: 'import.applied',
      resourceType: 'import_batch',
      resourceId: input.batchId,
      classification: 'SENSITIVE',
      after: outcome.counts,
    });
    return outcome;
  },

  /**
   * Takes an applied import back out.
   *
   * REFUSES rather than cascades. A learner created by this import who has since
   * been marked present, invoiced or graded cannot be removed without destroying
   * those records too — so the reversal stops and names them. An undo that
   * becomes a second disaster is worse than no undo.
   */
  async reverse(
    scope: TenantScope,
    input: { batchId: string; reason: string; reversedByStaffId: string },
  ): Promise<{ reversed: number }> {
    if (!input.reason.trim()) {
      throw ApiError.make('validation_error', 'reason_required',
        'Reversing an import needs a reason.');
    }

    const outcome = await withTenant(scope, async (db) => {
      await assertStatus(db, input.batchId, ['applied']);

      const written = await db.query<{
        id: string; target_table: string; target_id: string; action: string;
        before_values: Record<string, unknown> | null; sequence_no: number;
      }>(
        `SELECT id, target_table, target_id, action, before_values, sequence_no
           FROM import_applied_row
          WHERE import_batch_id = $1::uuid AND reversed_at IS NULL
          ORDER BY sequence_no DESC`,
        [input.batchId],
      );

      const blocked: string[] = [];
      for (const row of written.rows) {
        if (row.action !== 'create') continue;
        const referenced = await referencesTo(db, row.target_table, row.target_id);
        if (referenced.length > 0) {
          blocked.push(`${row.target_table} ${row.target_id} (${referenced.join(', ')})`);
        }
      }
      if (blocked.length > 0) {
        throw ApiError.make('conflict', 'reversal_blocked',
          `These rows have been used since the import and cannot be removed: ` +
          `${blocked.slice(0, 5).join('; ')}${blocked.length > 5 ? ` and ${blocked.length - 5} more` : ''}.`);
      }

      let reversed = 0;
      for (const row of written.rows) {
        if (row.action === 'create') {
          await db.query(
            `DELETE FROM ${quoteIdent(row.target_table)} WHERE id = $1::uuid`,
            [row.target_id],
          );
        } else if (row.before_values) {
          await restoreBefore(db, row.target_table, row.target_id, row.before_values);
        }
        await db.query(
          'UPDATE import_applied_row SET reversed_at = now() WHERE id = $1::uuid',
          [row.id],
        );
        reversed += 1;
      }

      await db.query(
        `UPDATE import_batch
            SET status = 'reversed', reversed_at = now(), reversed_by = $2::uuid,
                reverse_reason = $3
          WHERE id = $1::uuid`,
        [input.batchId, input.reversedByStaffId, input.reason],
      );

      return { reversed };
    });

    await auditService.record({
      tenantId: scope.tenantId,
      actorUserId: scope.actorId,
      action: 'import.reversed',
      resourceType: 'import_batch',
      resourceId: input.batchId,
      classification: 'SENSITIVE',
      reason: input.reason,
      after: outcome,
    });
    return outcome;
  },

  async rowsWithErrors(db: TenantClient, batchId: string): Promise<Array<{
    row_no: number; status: string; errors: RowError[];
  }>> {
    const { rows } = await db.query<{ row_no: number; status: string; errors: RowError[] }>(
      `SELECT row_no, status, errors FROM import_row
        WHERE import_batch_id = $1::uuid AND status IN ('invalid', 'duplicate')
        ORDER BY row_no`,
      [batchId],
    );
    return rows;
  },

  async batch(db: TenantClient, batchId: string): Promise<{
    status: string; plan_digest: string | null;
    preview_counts: PreviewCounts | null; applied_counts: PreviewCounts | null;
  } | undefined> {
    const { rows } = await db.query<{
      status: string; plan_digest: string | null;
      preview_counts: PreviewCounts | null; applied_counts: PreviewCounts | null;
    }>(
      `SELECT status, plan_digest, preview_counts, applied_counts
         FROM import_batch WHERE id = $1::uuid`,
      [batchId],
    );
    return rows[0];
  },
};

// ---------------------------------------------------------------------------
// The plan: ONE function, used by both preview and apply.
// ---------------------------------------------------------------------------

interface PlanItem {
  rowId: string;
  rowNo: number;
  action: 'create' | 'update' | 'skip';
  matchedId: string | null;
  values: Record<string, string>;
}

/**
 * Builds the plan and its digest.
 *
 * Preview and apply both call this. Two separate implementations that were
 * "kept in sync" is precisely how a preview stops matching an apply, so there is
 * only one.
 */
async function buildPlan(
  db: TenantClient, batchId: string, entity: ImportEntity,
): Promise<{ items: PlanItem[]; counts: PreviewCounts; digest: string }> {
  const spec = FIELDS[entity];

  const rows = await db.query<{
    id: string; row_no: number; status: string; normalised: Record<string, string> | null;
  }>(
    `SELECT id, row_no, status, normalised FROM import_row
      WHERE import_batch_id = $1::uuid ORDER BY row_no`,
    [batchId],
  );

  const keys = rows.rows
    .filter((r) => r.status === 'valid' && r.normalised?.[spec.key])
    .map((r) => r.normalised![spec.key]!);

  const existing = await existingByKey(db, entity, keys);

  const items: PlanItem[] = [];
  const counts: PreviewCounts = { total: rows.rows.length, create: 0, update: 0, skip: 0, invalid: 0 };

  for (const row of rows.rows) {
    if (row.status !== 'valid' || !row.normalised) {
      counts.invalid += 1;
      items.push({ rowId: row.id, rowNo: row.row_no, action: 'skip', matchedId: null, values: {} });
      counts.skip += 1;
      continue;
    }
    const key = row.normalised[spec.key];
    const match = key ? existing.get(key) : undefined;
    const action: PlanItem['action'] = match ? 'update' : 'create';
    if (action === 'create') counts.create += 1; else counts.update += 1;
    items.push({
      rowId: row.id, rowNo: row.row_no, action,
      matchedId: match ?? null, values: row.normalised,
    });
  }

  // The digest covers the decision AND the thing it was decided against, but
  // those turn out to be the same fact: `matchedId` IS what the row matched, so
  // a learner created by somebody else between preview and apply flips the
  // action and the matched id on that row's line. An extra term listing the
  // existing keys was tried here and removed — no mutation could make it matter,
  // which means it was decoration on a security-relevant hash, and decoration on
  // a hash is worse than nothing: it reads as coverage it does not provide.
  const hash = createHash('sha256');
  hash.update(`entity|${entity}\n`);
  for (const item of items) {
    hash.update(
      `R|${item.rowNo}|${item.action}|${item.matchedId ?? ''}|` +
      `${JSON.stringify(sortedEntries(item.values))}\n`,
    );
  }

  return { items, counts, digest: hash.digest('hex') };
}

function sortedEntries(values: Record<string, string>): Array<[string, string]> {
  return Object.entries(values).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** What already exists with these keys, so a re-import updates rather than duplicates. */
async function existingByKey(
  db: TenantClient, entity: ImportEntity, keys: string[],
): Promise<Map<string, string>> {
  if (keys.length === 0) return new Map();
  const found = new Map<string, string>();

  if (entity === 'learner_roster' || entity === 'guardian_link' || entity === 'fee_assignment') {
    const { rows } = await db.query<{ admission_no: string; id: string }>(
      'SELECT admission_no, id FROM student WHERE admission_no = ANY($1::text[])',
      [keys],
    );
    for (const r of rows) found.set(r.admission_no, r.id);
    return found;
  }

  const { rows } = await db.query<{ employee_code: string; id: string }>(
    'SELECT employee_code, id FROM staff WHERE employee_code = ANY($1::text[])',
    [keys],
  );
  for (const r of rows) found.set(r.employee_code, r.id);
  return found;
}

interface Written { table: string; id: string; action: 'create' | 'update'; before?: unknown }

async function applyOne(
  db: TenantClient,
  ctx: { batchId: string; entity: ImportEntity; item: PlanItem },
): Promise<Written[]> {
  const { entity, item } = ctx;
  if (entity !== 'learner_roster') {
    // The other entities follow the same shape and are not built yet. Failing
    // loudly beats a silent no-op that reports a successful import of nothing.
    throw ApiError.make('validation_error', 'entity_not_supported',
      `Importing ${entity} is not implemented yet.`);
  }

  const written: Written[] = [];
  const v = item.values;

  if (item.action === 'create') {
    const person = await db.query<{ id: string }>(
      `INSERT INTO person (tenant_id, given_name, family_name, date_of_birth)
       VALUES (app_current_tenant_id(), $1, $2::text, $3::date)
       RETURNING id`,
      [v['given_name'], v['family_name'] ?? null, v['date_of_birth'] ?? null],
    );
    written.push({ table: 'person', id: person.rows[0]!.id, action: 'create' });

    const student = await db.query<{ id: string }>(
      `INSERT INTO student (tenant_id, person_id, admission_no)
       VALUES (app_current_tenant_id(), $1::uuid, $2)
       RETURNING id`,
      [person.rows[0]!.id, v['admission_no']],
    );
    written.push({ table: 'student', id: student.rows[0]!.id, action: 'create' });
    return written;
  }

  // Update: only the fields the file actually carried. A blank cell is not an
  // instruction to erase a name.
  const student = await db.query<{ person_id: string }>(
    'SELECT person_id FROM student WHERE id = $1::uuid', [item.matchedId],
  );
  const personId = student.rows[0]!.person_id;
  const before = await db.query<Record<string, unknown>>(
    'SELECT given_name, family_name, date_of_birth::text AS date_of_birth FROM person WHERE id = $1::uuid',
    [personId],
  );

  await db.query(
    `UPDATE person
        SET given_name = COALESCE($2::text, given_name),
            family_name = COALESCE($3::text, family_name),
            date_of_birth = COALESCE($4::date, date_of_birth),
            updated_at = now()
      WHERE id = $1::uuid`,
    [personId, v['given_name'] ?? null, v['family_name'] ?? null,
     v['date_of_birth'] ?? null],
  );
  written.push({ table: 'person', id: personId, action: 'update', before: before.rows[0] });
  return written;
}

/**
 * What points at a row this import created.
 *
 * A closed list per table rather than a catalogue walk: the catalogue would find
 * the import's OWN bookkeeping rows and every future table automatically, which
 * sounds better until a reversal starts refusing for reasons nobody can read.
 */
async function referencesTo(
  db: TenantClient, table: string, id: string,
): Promise<string[]> {
  const CHECKS: Record<string, Array<[string, string, string]>> = {
    student: [
      ['enrollment', 'student_id', 'enrolled'],
      ['guardian_link', 'student_id', 'has a guardian linked'],
    ],
    person: [
      ['contact_method', 'person_id', 'has contact details'],
      ['consent_record', 'person_id', 'has consent on record'],
      ['staff', 'person_id', 'is a staff member'],
      ['application', 'applicant_person_id', 'has an application'],
    ],
  };

  const found: string[] = [];
  for (const [refTable, column, description] of CHECKS[table] ?? []) {
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${quoteIdent(refTable)}
        WHERE ${quoteIdent(column)} = $1::uuid`,
      [id],
    );
    if (Number(rows[0]!.n) > 0) found.push(description);
  }
  return found;
}

async function restoreBefore(
  db: TenantClient, table: string, id: string, before: Record<string, unknown>,
): Promise<void> {
  if (table !== 'person') return;
  await db.query(
    `UPDATE person SET given_name = $2::text, family_name = $3::text,
            date_of_birth = $4::date, updated_at = now()
      WHERE id = $1::uuid`,
    [id, before['given_name'] ?? null, before['family_name'] ?? null,
     before['date_of_birth'] ?? null],
  );
}

/**
 * Table and column names come from the closed lists above, never from user
 * input. This is belt and braces on top of that.
 */
function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw ApiError.make('internal_error', 'bad_identifier', 'Refusing an unexpected identifier.');
  }
  return `"${name}"`;
}

async function assertStatus(
  db: TenantClient, batchId: string, allowed: string[],
): Promise<{ entity: ImportEntity; status: string; plan_digest: string | null }> {
  const { rows } = await db.query<{
    entity: ImportEntity; status: string; plan_digest: string | null;
  }>(
    'SELECT entity, status, plan_digest FROM import_batch WHERE id = $1::uuid FOR UPDATE',
    [batchId],
  );
  const batch = rows[0];
  if (!batch) {
    throw ApiError.make('not_found', 'batch_not_found', 'Import batch not found.');
  }
  if (!allowed.includes(batch.status)) {
    throw ApiError.make('conflict', `batch_${batch.status}`,
      `This import is ${batch.status}; that step expects ${allowed.join(' or ')}.`);
  }
  return batch;
}

// ---------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------

/**
 * A closed set of named transforms.
 *
 * Not an expression language. An import mapping is user input, and an expression
 * evaluator over user input is a remote code execution waiting to be written.
 */
function applyTransform(
  raw: string, transform: Transform | null,
): { value: string; error?: string } {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') return { value: '' };

  switch (transform) {
    case null:
    case undefined:
    case 'trim':
      return { value: trimmed };
    case 'upper':
      return { value: trimmed.toUpperCase() };
    case 'lower':
      return { value: trimmed.toLowerCase() };
    case 'digits_only':
      return { value: trimmed.replace(/\D/g, '') };

    case 'phone_in': {
      // Excel turns a long number into 9.8765E+09 often enough that it is worth
      // naming: the scientific-notation form has lost digits and cannot be
      // recovered, so it is an error rather than something to parse.
      if (/e\+?\d+$/i.test(trimmed)) return { value: '', error: 'phone_lost_to_excel' };
      const digits = trimmed.replace(/[^\d]/g, '');
      const local = digits.length === 12 && digits.startsWith('91')
        ? digits.slice(2)
        : digits.length === 11 && digits.startsWith('0') ? digits.slice(1) : digits;
      if (local.length !== 10 || !/^[6-9]/.test(local)) {
        return { value: '', error: 'phone_invalid' };
      }
      return { value: `+91${local}` };
    }

    case 'date_dmy':
    case 'date_ymd': {
      const parts = trimmed.split(/[/\-.]/).map((p) => p.trim());
      if (parts.length !== 3) return { value: '', error: 'date_unparseable' };
      const [a, b, c] = parts as [string, string, string];
      const [d, m, y] = transform === 'date_dmy' ? [a, b, c] : [c, b, a];

      // A two-digit year in a school roster is a birth date, so 14 is 2014 and
      // 98 is 1998. Guessing is unavoidable here; guessing SILENTLY is not, so
      // the rule is written down rather than left to Date.parse.
      const year = y.length === 2 ? (Number(y) <= 30 ? 2000 + Number(y) : 1900 + Number(y))
        : Number(y);
      const month = Number(m);
      const day = Number(d);
      if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
        return { value: '', error: 'date_unparseable' };
      }
      const iso = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}` +
        `-${String(day).padStart(2, '0')}`;
      // Round-trip, because Date.parse('2014-02-31') happily returns 3 March.
      const parsed = new Date(`${iso}T00:00:00Z`);
      if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) {
        return { value: '', error: 'date_impossible' };
      }
      return { value: iso };
    }

    default:
      return { value: trimmed };
  }
}

function messageFor(code: string, raw: string): string {
  switch (code) {
    case 'phone_lost_to_excel':
      return `"${raw}" is a number Excel has rounded; the digits are gone. ` +
        'Format the column as text in the spreadsheet and upload again.';
    case 'phone_invalid':
      return `"${raw}" is not a ten-digit Indian mobile number.`;
    case 'date_unparseable':
      return `"${raw}" is not a date in the expected format.`;
    case 'date_impossible':
      return `"${raw}" is not a real date.`;
    default:
      return `"${raw}" could not be used.`;
  }
}
