/**
 * M9.1 — templates as first-class versioned objects.
 *
 * Not strings in the codebase, for three reasons that all bite in production:
 *
 *   - An SMS template must be registered on a DLT platform before an Indian
 *     operator will carry it. The registration is against a specific body, so
 *     the body and the registration id have to travel together and freeze
 *     together.
 *   - WhatsApp templates are approved by Meta, separately, with their own name
 *     and language, and a rejected one must be visibly rejected rather than
 *     silently unsendable.
 *   - Every institute wants its own wording, in its own languages. A string in
 *     the codebase is a release per customer.
 */
import { withTenant, type TenantScope, type TenantClient } from '../../db/tenant.ts';
import { ApiError } from '../../common/errors.ts';
import { auditService } from '../audit/audit.service.ts';

export type Channel = 'sms' | 'whatsapp' | 'email' | 'push' | 'in_app';
export type Purpose =
  | 'core_education_service' | 'attendance_notifications' | 'fee_notifications'
  | 'photo_publication' | 'transport_tracking' | 'third_party_assessment' | 'marketing';

export interface TemplateVersion {
  id: string;
  channel: Channel;
  locale: string;
  version: number;
  body: string;
  variables: string[];
  approval_status: 'draft' | 'submitted' | 'approved' | 'rejected';
  dlt_template_id: string | null;
  sender_header: string | null;
  wa_template_name: string | null;
}

const SELECT_VERSION = `id, channel, locale, version, body, variables, approval_status,
       dlt_template_id, sender_header, wa_template_name`;

/** `{{name}}` — the only interpolation syntax, matching what DLT registrations use. */
const VARIABLE_PATTERN = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

export function variablesIn(body: string): string[] {
  const found = new Set<string>();
  for (const match of body.matchAll(VARIABLE_PATTERN)) found.add(match[1]!);
  return [...found].sort();
}

/**
 * Renders a body against values.
 *
 * A missing variable is an ERROR, not an empty string. The alternative is a
 * parent receiving "Dear , your child  was absent" — or worse, the literal
 * `{{learner_name}}`, which is what actually happens and what people screenshot.
 */
export function render(body: string, values: Record<string, string>): string {
  const missing: string[] = [];
  const out = body.replace(VARIABLE_PATTERN, (_whole, name: string) => {
    const value = values[name];
    if (value === undefined || value === null || value === '') {
      missing.push(name);
      return '';
    }
    return value;
  });
  if (missing.length > 0) {
    throw ApiError.make('validation_error', 'missing_variables',
      `The template needs values for: ${[...new Set(missing)].sort().join(', ')}.`);
  }
  return out;
}

export const templateService = {
  async create(
    scope: TenantScope,
    input: { code: string; name: string; purpose: Purpose },
  ): Promise<{ id: string }> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO message_template (tenant_id, code, name, purpose)
         VALUES (app_current_tenant_id(), $1, $2, $3)
         RETURNING id`,
        [input.code, input.name, input.purpose],
      );
      return { id: rows[0]!.id };
    });
  },

  /**
   * Adds a draft version. The variable list is derived from the body rather
   * than supplied, so the two cannot disagree — a hand-maintained list that has
   * drifted is how a render silently omits a value.
   */
  async addVersion(
    scope: TenantScope,
    input: {
      templateId: string; channel: Channel; locale?: string; body: string;
      dltEntityId?: string; dltTemplateId?: string; senderHeader?: string;
      waTemplateName?: string; waLanguage?: string;
    },
  ): Promise<TemplateVersion> {
    if (!input.body.trim()) {
      throw ApiError.make('validation_error', 'empty_body', 'A template needs a body.');
    }

    return withTenant(scope, async (db) => {
      const prior = await db.query<{ version: number }>(
        `SELECT COALESCE(max(version), 0) AS version
           FROM message_template_version
          WHERE message_template_id = $1::uuid AND channel = $2 AND locale = $3`,
        [input.templateId, input.channel, input.locale ?? 'en-IN'],
      );
      const version = Number(prior.rows[0]?.version ?? 0) + 1;

      const { rows } = await db.query<TemplateVersion>(
        `INSERT INTO message_template_version
           (tenant_id, message_template_id, channel, locale, version, body, variables,
            dlt_entity_id, dlt_template_id, sender_header, wa_template_name, wa_language)
         VALUES (app_current_tenant_id(), $1::uuid, $2, $3, $4::integer, $5, $6::text[],
                 $7::text, $8::text, $9::text, $10::text, $11::text)
         RETURNING ${SELECT_VERSION}`,
        [input.templateId, input.channel, input.locale ?? 'en-IN', version,
         input.body, variablesIn(input.body),
         input.dltEntityId ?? null, input.dltTemplateId ?? null, input.senderHeader ?? null,
         input.waTemplateName ?? null, input.waLanguage ?? null],
      );
      return rows[0]!;
    });
  },

  /**
   * Marks a version approved by its registrar.
   *
   * The CHECK constraints refuse an approved SMS version without its DLT ids and
   * an approved WhatsApp version without its Meta name — because an approved
   * template that cannot legally be sent is worse than a draft: it looks ready.
   */
  async approve(
    scope: TenantScope, versionId: string,
  ): Promise<void> {
    await withTenant(scope, async (db) => {
      const { rowCount } = await db.query(
        `UPDATE message_template_version
            SET approval_status = 'approved', approved_at = now(), updated_at = now()
          WHERE id = $1::uuid AND approval_status IN ('draft', 'submitted')`,
        [versionId],
      );
      if (rowCount === 0) {
        throw ApiError.make('conflict', 'not_approvable',
          'That version does not exist or is already settled.');
      }
    });

    await auditService.record({
      tenantId: scope.tenantId,
      actorUserId: scope.actorId,
      action: 'message_template.approved',
      resourceType: 'message_template_version',
      resourceId: versionId,
      classification: 'INTERNAL',
    });
  },

  async reject(scope: TenantScope, versionId: string, reason: string): Promise<void> {
    if (!reason.trim()) {
      throw ApiError.make('validation_error', 'reason_required',
        'A rejection needs the registrar\'s reason; it is what the next version has to fix.');
    }
    await withTenant(scope, async (db) => {
      await db.query(
        `UPDATE message_template_version
            SET approval_status = 'rejected', rejection_reason = $2, updated_at = now()
          WHERE id = $1::uuid AND approval_status IN ('draft', 'submitted')`,
        [versionId, reason],
      );
    });
  },

  /**
   * The approved version to send on a channel, preferring the recipient's
   * locale and falling back to `en-IN`.
   *
   * Falling back rather than failing is deliberate: a parent who set Hindi and
   * whose Hindi template has not been approved yet should still be told their
   * child is absent.
   */
  async approvedVersion(
    db: TenantClient,
    templateId: string,
    channel: Channel,
    locale?: string,
  ): Promise<TemplateVersion | undefined> {
    const { rows } = await db.query<TemplateVersion>(
      `SELECT ${SELECT_VERSION}
         FROM message_template_version
        WHERE message_template_id = $1::uuid
          AND channel = $2
          AND approval_status = 'approved'
          AND locale = ANY($3::text[])
        ORDER BY (locale = $4) DESC, version DESC
        LIMIT 1`,
      [templateId, channel, [locale ?? 'en-IN', 'en-IN'], locale ?? 'en-IN'],
    );
    return rows[0];
  },

  async byCode(db: TenantClient, code: string): Promise<{
    id: string; purpose: Purpose;
  } | undefined> {
    const { rows } = await db.query<{ id: string; purpose: Purpose }>(
      `SELECT id, purpose FROM message_template
        WHERE code = $1 AND deleted_at IS NULL`,
      [code],
    );
    return rows[0];
  },
};
