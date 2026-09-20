/**
 * M8.4 and M8.5 — report cards: issue, publish, correct.
 *
 * The rule the whole file exists for: **a published card is immutable, and a
 * correction is a new version.** The old one is retained with its snapshot, so
 * the school can answer "what did the card we sent in March actually say" —
 * which is the question that arrives with a lawyer attached, and the one an
 * UPDATE makes permanently unanswerable.
 *
 * The snapshot is the other half of that. A card rendered live from a template
 * silently changes whenever the template does, so a card published in March and
 * reopened in July shows a layout and possibly figures the family never saw.
 * The data is frozen INTO the card at publication.
 */
import { createHash } from 'node:crypto';
import { withTenant, type TenantScope, type TenantClient } from '../../db/tenant.ts';
import { ApiError } from '../../common/errors.ts';
import { auditService } from '../audit/audit.service.ts';
import { outboxService } from '../events/outbox.service.ts';
import { resultService } from './result.service.ts';

export interface ReportCard {
  id: string;
  enrollment_id: string;
  term_id: string;
  version: number;
  status: 'draft' | 'published' | 'superseded';
  result_run_id: string;
  artefact_sha256: string | null;
}

const SELECT_CARD = `id, enrollment_id, term_id, version, status, result_run_id,
       artefact_sha256`;

export const reportCardService = {
  async createTemplate(
    scope: TenantScope,
    input: { academicUnitId: string; name: string;
             board?: string | undefined; layout: unknown },
  ): Promise<{ id: string; version: number }> {
    return withTenant(scope, async (db) => {
      // A new version rather than an edit, for the same reason cards are
      // versioned: a template someone has already published cards against is
      // part of the record.
      const prior = await db.query<{ version: number }>(
        `SELECT COALESCE(max(version), 0) AS version
           FROM report_card_template
          WHERE academic_unit_id = $1::uuid AND name = $2 AND deleted_at IS NULL`,
        [input.academicUnitId, input.name],
      );
      const version = Number(prior.rows[0]?.version ?? 0) + 1;

      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO report_card_template
           (tenant_id, academic_unit_id, name, board, layout, version)
         VALUES (app_current_tenant_id(), $1::uuid, $2, $3::text, $4::jsonb, $5::integer)
         RETURNING id`,
        [input.academicUnitId, input.name, input.board ?? null,
         JSON.stringify(input.layout), version],
      );
      return { id: rows[0]!.id, version };
    });
  },

  /**
   * Issues draft cards for every learner in a published run.
   *
   * Drafts, not published cards: rendering and publishing are separate acts so
   * the office can look at what a family will receive before the family does.
   */
  async issueForRun(
    scope: TenantScope,
    input: { runId: string; templateId?: string | undefined },
  ): Promise<{ created: number; cards: ReportCard[] }> {
    const cards = await withTenant(scope, async (db) => {
      const run = await db.query<{ status: string; term_id: string }>(
        'SELECT status, term_id FROM result_run WHERE id = $1::uuid', [input.runId],
      );
      const r = run.rows[0];
      if (!r) throw ApiError.make('not_found', 'run_not_found', 'Result run not found.');
      if (r.status !== 'published') {
        throw ApiError.make('conflict', 'run_not_published',
          'Cards can only be issued from a published run.');
      }

      const lines = await resultService.linesFor(db, input.runId);
      const byEnrollment = new Map<string, typeof lines>();
      for (const line of lines) {
        const list = byEnrollment.get(line.enrollment_id);
        if (list) list.push(line);
        else byEnrollment.set(line.enrollment_id, [line]);
      }

      const created: ReportCard[] = [];
      for (const [enrollmentId, ownLines] of byEnrollment) {
        const prior = await db.query<{ version: number }>(
          `SELECT COALESCE(max(version), 0) AS version
             FROM report_card WHERE enrollment_id = $1::uuid AND term_id = $2::uuid`,
          [enrollmentId, r.term_id],
        );
        const version = Number(prior.rows[0]?.version ?? 0) + 1;

        const snapshot = {
          runId: input.runId,
          termId: r.term_id,
          lines: ownLines,
        };
        const sha = createHash('sha256')
          .update(JSON.stringify(snapshot))
          .digest('hex');

        const { rows } = await db.query<ReportCard>(
          `INSERT INTO report_card
             (tenant_id, enrollment_id, term_id, result_run_id, template_id,
              version, snapshot, artefact_sha256)
           VALUES (app_current_tenant_id(), $1::uuid, $2::uuid, $3::uuid, $4::uuid,
                   $5::integer, $6::jsonb, $7)
           RETURNING ${SELECT_CARD}`,
          [enrollmentId, r.term_id, input.runId, input.templateId ?? null,
           version, JSON.stringify(snapshot), sha],
        );
        created.push(rows[0]!);
      }
      return created;
    });

    return { created: cards.length, cards };
  },

  /**
   * Publishes a draft card. After this the family can see it, and nothing about
   * it can change — the database trigger in 0032 refuses any edit to the
   * snapshot, the hash, the run or the version.
   */
  async publish(
    scope: TenantScope, input: { cardId: string; publishedByStaffId: string },
  ): Promise<void> {
    await withTenant(scope, async (db) => {
      const { rowCount } = await db.query(
        `UPDATE report_card
            SET status = 'published', published_at = now(), published_by = $2::uuid
          WHERE id = $1::uuid AND status = 'draft'`,
        [input.cardId, input.publishedByStaffId],
      );
      if (rowCount === 0) {
        throw ApiError.make('conflict', 'not_a_draft',
          'Only a draft report card can be published.');
      }

      await outboxService.emit(db, {
        eventType: 'report_card.published',
        aggregateType: 'report_card',
        aggregateId: input.cardId,
        payload: { cardId: input.cardId },
      });
    });

    await auditService.record({
      tenantId: scope.tenantId,
      actorUserId: scope.actorId,
      action: 'report_card.published',
      resourceType: 'report_card',
      resourceId: input.cardId,
      classification: 'SENSITIVE',
    });
  },

  /**
   * Corrects a published card by issuing the next version and standing the
   * previous one down.
   *
   * The old row keeps its snapshot and its hash. That is the whole design: a
   * correction adds to the record rather than rewriting it.
   */
  async correct(
    scope: TenantScope,
    input: {
      cardId: string; newRunId: string; reason: string; byStaffId: string;
      templateId?: string;
    },
  ): Promise<{ id: string; version: number }> {
    if (!input.reason.trim()) {
      throw ApiError.make('validation_error', 'reason_required',
        'A corrected report card needs a reason.');
    }

    const result = await withTenant(scope, async (db) => {
      const found = await db.query<{
        enrollment_id: string; term_id: string; version: number; status: string;
      }>(
        `SELECT enrollment_id, term_id, version, status
           FROM report_card WHERE id = $1::uuid FOR UPDATE`,
        [input.cardId],
      );
      const old = found.rows[0];
      if (!old) throw ApiError.make('not_found', 'card_not_found', 'Report card not found.');
      if (old.status !== 'published') {
        throw ApiError.make('conflict', 'not_published',
          'Only a published card needs correcting; a draft can simply be reissued.');
      }

      const lines = await resultService.linesFor(db, input.newRunId);
      const ownLines = lines.filter((l) => l.enrollment_id === old.enrollment_id);
      if (ownLines.length === 0) {
        throw ApiError.make('conflict', 'no_lines_for_learner',
          'The replacement run has no results for this learner.');
      }

      const snapshot = {
        runId: input.newRunId,
        termId: old.term_id,
        lines: ownLines,
        supersedes: input.cardId,
      };
      const sha = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');

      // The old card steps down first: one live card per learner per term is a
      // partial unique index, and two published versions would be two truths.
      const replacement = await db.query<{ id: string; version: number }>(
        `INSERT INTO report_card
           (tenant_id, enrollment_id, term_id, result_run_id, template_id, version,
            snapshot, artefact_sha256, status, published_at, published_by)
         VALUES (app_current_tenant_id(), $1::uuid, $2::uuid, $3::uuid, $4::uuid,
                 $5::integer, $6::jsonb, $7, 'draft', NULL, NULL)
         RETURNING id, version`,
        [old.enrollment_id, old.term_id, input.newRunId, input.templateId ?? null,
         old.version + 1, JSON.stringify(snapshot), sha],
      );
      const next = replacement.rows[0]!;

      await db.query(
        `UPDATE report_card
            SET status = 'superseded', superseded_by = $2::uuid, supersede_reason = $3
          WHERE id = $1::uuid`,
        [input.cardId, next.id, input.reason],
      );
      await db.query(
        `UPDATE report_card
            SET status = 'published', published_at = now(), published_by = $2::uuid
          WHERE id = $1::uuid`,
        [next.id, input.byStaffId],
      );

      return next;
    });

    await auditService.record({
      tenantId: scope.tenantId,
      actorUserId: scope.actorId,
      action: 'report_card.corrected',
      resourceType: 'report_card',
      resourceId: input.cardId,
      classification: 'SENSITIVE',
      reason: input.reason,
      after: { replacedBy: result.id, version: result.version },
    });
    return result;
  },

  async versionsFor(
    db: TenantClient, enrollmentId: string, termId: string,
  ): Promise<ReportCard[]> {
    const { rows } = await db.query<ReportCard>(
      `SELECT ${SELECT_CARD} FROM report_card
        WHERE enrollment_id = $1::uuid AND term_id = $2::uuid
        ORDER BY version`,
      [enrollmentId, termId],
    );
    return rows;
  },

  async byId(scope: TenantScope, cardId: string): Promise<ReportCard | undefined> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<ReportCard>(
        `SELECT ${SELECT_CARD} FROM report_card WHERE id = $1::uuid`, [cardId],
      );
      return rows[0];
    });
  },
};
