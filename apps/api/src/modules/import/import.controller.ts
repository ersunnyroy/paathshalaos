/**
 * Running an import (M32.3).
 *
 * M9.6 built the whole pipeline — staging, column mapping, transforms,
 * validation, a preview with a plan digest, apply, and a reversal that can
 * take it all back — and the product had `GET /v1/imports` and no way to run
 * one. `importService` had no caller in `src/`. Onboarding a school means
 * typing in four hundred learners by hand.
 *
 * The steps stay separate and in order, which is the design and not an
 * oversight:
 *
 *   upload → map → validate → preview → apply
 *
 * The preview computes a digest of exactly what will be written, and `apply`
 * refuses unless that digest is present. A one-shot "import this file" would
 * remove the only moment where somebody sees what is about to happen to four
 * hundred children's records before it happens.
 *
 * CSV is parsed here rather than in the service, because parsing is a property
 * of the transport (a multipart upload, a pasted blob, a future S3 key) and
 * staging is not.
 */
import { Controller, Get, Post, Body, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import { importService } from './import.service.ts';
import { withTenant } from '../../db/tenant.ts';
import { currentScope } from '../../common/scope.ts';
import { ApiError } from '../../common/errors.ts';

const uuid = z.string().uuid();

const ENTITIES = ['learner_roster', 'staff_roster', 'guardian_link',
                  'fee_assignment'] as const;

const uploadBody = z.object({
  entity: z.enum(ENTITIES),
  originalFilename: z.string().max(260).optional(),
  campusId: uuid.optional(),
  /** The file, as text. Bounded so one paste cannot exhaust the process. */
  csv: z.string().min(1).max(5_000_000),
});

const mappingBody = z.object({
  mappings: z.array(z.object({
    sourceColumn: z.string().min(1).max(200),
    targetField: z.string().min(1).max(60),
    transform: z.enum(['trim', 'upper', 'lower', 'digits_only', 'phone_in',
                       'date_dmy', 'date_ymd']).optional(),
    isRequired: z.boolean().optional(),
    defaultValue: z.string().max(200).optional(),
  })).min(1).max(60),
});

/**
 * A CSV parser that handles quotes, because school data contains commas.
 *
 * "Sharma, Priya" in a name column is the normal case, not the edge one, and
 * a split(',') turns one learner into two columns of nonsense that validation
 * cannot recover from. Embedded newlines inside quotes are handled for the
 * same reason: an address field wraps.
 *
 * Deliberately not a dependency. The format this accepts is RFC 4180 plus
 * CRLF tolerance, it is forty lines, and a parser with its own release
 * schedule is a larger liability than the forty lines.
 */
function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else { quoted = false; }
      } else { field += ch; }
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  // A file with no trailing newline still has a last row.
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }

  const header = rows.shift();
  if (!header || header.length === 0) {
    throw ApiError.make('validation_error', 'no_header',
      'The first line of the file has to be the column names.');
  }
  const names = header.map((h) => h.trim());

  return rows
    // A row of nothing is not a learner with no name. This is NOT about the
    // trailing newline — the parser already drops that, since it leaves no
    // field and no row behind. It is about the line of stray commas that a
    // spreadsheet export leaves in the middle or at the end of a file, which
    // parses into real empty columns and would import as a nameless child.
    .filter((r) => r.some((v) => v.trim() !== ''))
    .map((r) => {
      const record: Record<string, string> = {};
      names.forEach((name, i) => { record[name] = (r[i] ?? '').trim(); });
      return record;
    });
}

@Controller('v1/imports')
export class ImportController {
  /**
   * Upload and stage in one call.
   *
   * These two are one step in a way the later ones are not: a batch with no
   * rows in it is not a state anybody wants to be in, and an upload that half
   * happened is a batch somebody has to clean up.
   */
  @Post()
  async upload(@Body() body: unknown) {
    const parsed = uploadBody.safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    const scope = currentScope();

    const rows = parseCsv(parsed.data.csv);
    if (rows.length === 0) {
      throw ApiError.make('validation_error', 'no_rows',
        'The file has a header and no rows.');
    }

    const staffId = await withTenant(scope, async (db) => {
      const { rows: r } = await db.query<{ staff_id: string | null }>(
        'SELECT app_current_staff_id() AS staff_id');
      return r[0]?.staff_id ?? undefined;
    });

    const batch = await importService.createBatch(scope, {
      entity: parsed.data.entity,
      ...(parsed.data.originalFilename
        ? { originalFilename: parsed.data.originalFilename } : {}),
      ...(parsed.data.campusId ? { campusId: parsed.data.campusId } : {}),
      ...(staffId ? { uploadedByStaffId: staffId } : {}),
    });
    const staged = await importService.stageRows(scope, {
      batchId: batch.id, rows,
    });

    return {
      data: {
        batchId: batch.id,
        staged: staged.staged,
        columns: Object.keys(rows[0] ?? {}),
      },
    };
  }

  @Post(':id/mapping')
  async setMapping(@Param('id') id: string, @Body() body: unknown) {
    const batchId = uuid.safeParse(id);
    if (!batchId.success) throw ApiError.fromZod(batchId.error);
    const parsed = mappingBody.safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    await importService.setMapping(currentScope(), {
      batchId: batchId.data, mappings: parsed.data.mappings,
    });
    return { data: { mapped: true } };
  }

  @Post(':id/validate')
  async validate(@Param('id') id: string) {
    const batchId = uuid.safeParse(id);
    if (!batchId.success) throw ApiError.fromZod(batchId.error);
    return { data: await importService.validate(currentScope(), batchId.data) };
  }

  /** What would happen, and the digest that `apply` will insist on. */
  @Post(':id/preview')
  async preview(@Param('id') id: string) {
    const batchId = uuid.safeParse(id);
    if (!batchId.success) throw ApiError.fromZod(batchId.error);
    return { data: await importService.preview(currentScope(), batchId.data) };
  }

  @Post(':id/apply')
  async apply(@Param('id') id: string) {
    const batchId = uuid.safeParse(id);
    if (!batchId.success) throw ApiError.fromZod(batchId.error);
    const scope = currentScope();
    const staffId = await withTenant(scope, async (db) => {
      const { rows } = await db.query<{ staff_id: string | null }>(
        'SELECT app_current_staff_id() AS staff_id');
      return rows[0]?.staff_id ?? undefined;
    });
    if (!staffId) {
      throw ApiError.make('permission_error', 'not_staff',
        'An import is recorded against the person who ran it, and this '
        + 'account is not linked to a member of staff.');
    }
    return {
      data: await importService.apply(scope, {
        batchId: batchId.data, appliedByStaffId: staffId,
      }),
    };
  }

  /**
   * Undo, with a reason.
   *
   * The feature that makes an import safe to attempt. A school that cannot
   * take a bad import back will not run a good one either.
   */
  @Post(':id/reverse')
  async reverse(@Param('id') id: string, @Body() body: unknown) {
    const batchId = uuid.safeParse(id);
    if (!batchId.success) throw ApiError.fromZod(batchId.error);
    const parsed = z.object({ reason: z.string().min(1).max(2000) }).safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    const scope = currentScope();
    const staffId = await withTenant(scope, async (db) => {
      const { rows } = await db.query<{ staff_id: string | null }>(
        'SELECT app_current_staff_id() AS staff_id');
      return rows[0]?.staff_id ?? undefined;
    });
    if (!staffId) {
      throw ApiError.make('permission_error', 'not_staff',
        'A reversal is recorded against the person who ran it, and this '
        + 'account is not linked to a member of staff.');
    }
    return {
      data: await importService.reverse(scope, {
        batchId: batchId.data, reason: parsed.data.reason, reversedByStaffId: staffId,
      }),
    };
  }

  /**
   * Where a batch has got to.
   *
   * Declared before `:id/errors` only for reading order; the two differ by a
   * segment. It exists because a client that starts an import had no way to
   * ask about it afterwards — every other endpoint here is a verb, and a
   * screen that uploads four hundred learners and then wants to know whether
   * the apply finished had to guess from the response it already had.
   *
   * `plan_digest` is what makes preview-then-apply honest: the digest is
   * computed over the plan the preview showed, and apply refuses if the file
   * has changed underneath it. A client comparing the two knows whether what
   * it is looking at is still what will happen.
   */
  @Get(':id')
  async batch(@Param('id') id: string) {
    const batchId = uuid.safeParse(id);
    if (!batchId.success) throw ApiError.fromZod(batchId.error);
    const found = await withTenant(currentScope(), (db) =>
      importService.batch(db, batchId.data));
    if (!found) {
      throw ApiError.make('not_found', 'batch_not_found', 'No such import batch.');
    }
    return { data: found };
  }

  /** The rows that did not pass, so somebody can fix the file. */
  @Get(':id/errors')
  async errors(@Param('id') id: string, @Query('limit') limit?: string) {
    const batchId = uuid.safeParse(id);
    if (!batchId.success) throw ApiError.fromZod(batchId.error);
    const cap = z.coerce.number().int().min(1).max(500).default(100)
      .safeParse(limit ?? undefined);
    if (!cap.success) throw ApiError.fromZod(cap.error);
    return {
      data: await withTenant(currentScope(),
        (db) => importService.rowsWithErrors(db, batchId.data)
          .then((rows) => rows.slice(0, cap.data))),
    };
  }
}
