/**
 * One place that answers "which language does this person read?" (M29.1).
 *
 * Before this, the answer was computed twice — once in `dispatch.service.ts`
 * and once in `template.service.ts` — and both computations were the same
 * hard-coded `'en-IN'`. Two copies of a wrong answer is not redundancy.
 *
 * The chain is: **what the person asked for → what the school teaches in →
 * `en-IN`.** Each link earns its place:
 *
 *   - The person's own preference wins because a parent who set Hindi has told
 *     us something the school's default cannot override.
 *   - The school's `organization.locale` comes next because a Tamil-medium
 *     school's parents overwhelmingly read Tamil, and asking each of eight
 *     hundred families to set a preference before the product works for them is
 *     not a migration path anybody completes.
 *   - `en-IN` is last because it is the only tag every seeded row carries, not
 *     because it is anybody's language.
 */
import { withTenant, type TenantClient, type TenantScope } from '../../db/tenant.ts';
import { chain, normalise, isTeachingLocale, DEFAULT_LOCALE, TEACHING_LOCALES } from './locales.ts';
import { ApiError } from '../../common/errors.ts';
import { auditService } from '../audit/audit.service.ts';

export const localeService = {
  /**
   * The school's own language.
   *
   * Read through RLS on the tenant pool, so this returns the caller's school
   * and cannot return anybody else's — `organization` carries the same
   * `tenant_isolation` policy as every other table, and the row the caller can
   * see is by definition their own.
   *
   * Falls back to `DEFAULT_LOCALE` if the row is somehow unreadable rather than
   * throwing. A send that fails because the language lookup failed would be a
   * new way for messages to go missing, invented by the module whose job is to
   * stop messages going missing.
   */
  async forOrganization(db: TenantClient): Promise<string> {
    const { rows } = await db.query<{ locale: string | null }>(
      'SELECT locale FROM organization WHERE id = app_current_tenant_id()');
    return chain(rows[0]?.locale)[0]!;
  },

  /**
   * The chain for one person, most-wanted first.
   *
   * `organizationLocale` is passed in rather than read here because the caller
   * that matters dispatches to hundreds of people inside one transaction, and
   * the school's language does not change between recipient four and recipient
   * five. Omitting it costs one extra query per person; supplying it costs
   * nothing and is what `dispatch` does.
   *
   * ## Why a preference for a *different* purpose still counts
   *
   * `communication_preference.locale` is keyed per purpose, which is a schema
   * decision this module has to live with: a language is a property of the
   * reader, not of the subject. A parent who set Hindi for fee reminders reads
   * Hindi when the message is about attendance.
   *
   * So *every* locale they have stated goes into the chain, the one for this
   * purpose first and the rest most-recently-set first — all of them ahead of
   * the school's default. Somebody who chose Tamil for attendance and Bengali
   * for fees has told us twice which languages they read; falling from a
   * missing Tamil template to the school's Hindi, past their own Bengali,
   * would be preferring an assumption to a statement. Ordering by
   * `(purpose = $2) DESC, updated_at DESC, purpose` makes two rows that
   * disagree produce one answer rather than a coin flip.
   */
  async chainFor(
    db: TenantClient,
    personId: string,
    purpose: string,
    organizationLocale?: string,
  ): Promise<string[]> {
    const { rows } = await db.query<{ stated: string[] | null }>(
      `SELECT array_agg(locale ORDER BY (purpose = $2) DESC, updated_at DESC, purpose)
                AS stated
         FROM communication_preference
        WHERE person_id = $1::uuid AND locale IS NOT NULL`,
      [personId, purpose],
    );
    return chain(
      ...(rows[0]?.stated ?? []),
      organizationLocale ?? (await localeService.forOrganization(db)),
    );
  },

  /**
   * The chain when there is no person — a notice, a portal, a school-wide page.
   *
   * Still a chain rather than the bare organisation locale, so the template and
   * string lookups downstream take the same shape whether or not a reader is
   * known.
   */
  async chainForOrganization(db: TenantClient): Promise<string[]> {
    return chain(await localeService.forOrganization(db));
  },

  /**
   * The tag a school or a person may be *set* to (M29.3).
   *
   * Writing is restricted to `TEACHING_LOCALES`; reading is not. That asymmetry
   * is deliberate and is the only place the two differ.
   *
   * Resolution has to tolerate whatever is already in the column — a row
   * imported from a school's old system, a tag from before this list existed —
   * because dropping it would route a family to English past templates that
   * exist for them. But a *picker* that accepts free text is how `en_US`,
   * `English` and `hindi` end up in the same column, none of which match a
   * template row and all of which look like a setting that worked. Adding a tag
   * to the list is a one-line change; recovering a column full of near-misses
   * is not.
   */
  assertSettable(input: string): string {
    const tag = normalise(input);
    if (!tag || !isTeachingLocale(tag)) {
      throw ApiError.make('validation_error', 'unknown_locale',
        `${input} is not a language this can be set to. `
        + `Choose one of: ${TEACHING_LOCALES.map((l) => l.tag).join(', ')}.`);
    }
    return tag;
  },

  /**
   * Sets one person's language.
   *
   * `communication_preference` is keyed per purpose, so "my language" does not
   * map to one row. Rather than write a row per purpose — which creates exactly
   * the disagreeing-rows case `chainFor` then has to arbitrate — this writes
   * the canonical row under `core_education_service` and brings every other row
   * the person already has into line. After this call the person has ONE stated
   * language, whatever shape the table is in.
   *
   * `core_education_service` is the anchor because it is the one basis that
   * always applies and can never be withdrawn: a person always has it, so the
   * row can always exist.
   *
   * Who may call this is the database's decision, not this function's:
   * `preference_own` permits staff, or the person themselves. A parent passing
   * somebody else's id writes nothing, which is why the row count is checked.
   */
  async setForPerson(
    scope: TenantScope, personId: string, input: string,
  ): Promise<{ personId: string; locale: string }> {
    const locale = localeService.assertSettable(input);
    await withTenant(scope, async (db) => {
      try {
        await db.query(
          `INSERT INTO communication_preference (tenant_id, person_id, purpose, locale)
           VALUES (app_current_tenant_id(), $1::uuid, 'core_education_service', $2)
           ON CONFLICT (tenant_id, person_id, purpose)
             DO UPDATE SET locale = EXCLUDED.locale, updated_at = now()`,
          [personId, locale],
        );
      } catch (e) {
        const code = (e as { code?: string }).code;
        // 42501 is the WITH CHECK on `preference_own` refusing the write, and
        // 23503 is a person id that belongs to no row here. Both are "not
        // yours to set", and they answer identically on purpose: whether that
        // person exists is not a parent's business. A 403 would confirm the id.
        if (code === '42501' || code === '23503') {
          throw ApiError.make('not_found', 'person_not_found',
            'No such person, or not yours to change.');
        }
        throw e;
      }
      await db.query(
        `UPDATE communication_preference
            SET locale = $2, updated_at = now()
          WHERE person_id = $1::uuid AND purpose <> 'core_education_service'
            AND locale IS DISTINCT FROM $2`,
        [personId, locale],
      );
    });
    return { personId, locale };
  },

  /**
   * Sets the school's own language — the middle link of every chain.
   *
   * The refusal comes from the policy added in 0079, not from a check here. A
   * guardian could UPDATE `organization` from 0003 until then; the grant was
   * there and only the absence of an endpoint hid it. Putting the rule in the
   * controller would have fixed this endpoint and left the next one exposed.
   */
  async setForOrganization(scope: TenantScope, input: string): Promise<{ locale: string }> {
    const locale = localeService.assertSettable(input);
    const before = await withTenant(scope, (db) => localeService.forOrganization(db));
    await withTenant(scope, async (db) => {
      const { rowCount } = await db.query(
        'UPDATE organization SET locale = $1, updated_at = now() WHERE id = app_current_tenant_id()',
        [locale]);
      if (rowCount === 0) {
        throw ApiError.make('permission_error', 'not_yours_to_change',
          'Changing the school\'s language needs an organisation-wide owner or '
          + 'administrator grant.');
      }
    });
    await auditService.record({
      tenantId: scope.tenantId,
      actorUserId: scope.actorId,
      action: 'organization.locale_changed',
      resourceType: 'organization',
      resourceId: scope.tenantId,
      classification: 'INTERNAL',
      before: { locale: before },
      after: { locale },
    });
    return { locale };
  },

  /**
   * What a caller would be written to in, and why.
   *
   * Returns the chain rather than one tag, because the answer a settings screen
   * has to show is not "Hindi" but "Hindi, because you asked for it" versus
   * "Hindi, because that is what the school uses" — and those are two different
   * things to offer to change.
   */
  async describe(scope: TenantScope, personId?: string): Promise<{
    chain: string[]; organization: string;
    stated: Array<{ purpose: string; locale: string }>;
    personId: string | null;
  }> {
    return withTenant(scope, async (db) => {
      const organization = await localeService.forOrganization(db);
      const who = personId ?? (await db.query<{ id: string | null }>(
        'SELECT app_current_person_id() AS id')).rows[0]?.id ?? null;
      if (!who) return { chain: chain(organization), organization, stated: [], personId: null };

      const stated = await db.query<{ purpose: string; locale: string }>(
        `SELECT purpose, locale FROM communication_preference
          WHERE person_id = $1::uuid AND locale IS NOT NULL
          ORDER BY updated_at DESC, purpose`,
        [who]);
      return {
        chain: await localeService.chainFor(db, who, 'core_education_service', organization),
        organization,
        stated: stated.rows,
        personId: who,
      };
    });
  },
};

export { DEFAULT_LOCALE };
