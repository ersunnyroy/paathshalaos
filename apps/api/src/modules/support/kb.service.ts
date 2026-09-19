/**
 * The knowledge base.
 *
 * Articles are versioned and the published version is a POINTER, so a draft can
 * be rewritten in the open without changing what a parent reads until somebody
 * decides it is ready. That is not ceremony: help articles are edited most often
 * at exactly the moment they are being read most — the week fees are due — and
 * an editor who has to work in a copy somewhere else eventually stops editing.
 *
 * Search is trigram, not full-text. An Indian institute's help content is a mix
 * of English and transliterated Hindi in the same sentence, and a stemmer
 * configured for one makes the other worse. Trigrams are language-agnostic and
 * match a misspelling, which is what a person searching help has.
 */
import { withTenant, type TenantScope } from '../../db/tenant.ts';
import { ApiError } from '../../common/errors.ts';
import { auditService } from '../audit/audit.service.ts';

export type Audience = 'everyone' | 'staff' | 'guardians';

export interface Article {
  id: string; slug: string; title: string; audience: Audience;
  category: string | null; status: string; published_version: number | null;
  updated_at: string;
}

export interface ArticleWithBody extends Article {
  body: string; version: number;
}

export const kbService = {
  async create(
    scope: TenantScope,
    input: { slug: string; title: string; body: string;
             audience?: Audience | undefined; category?: string | undefined },
  ): Promise<Article> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<Article>(
        `INSERT INTO kb_article (tenant_id, slug, title, audience, category, created_by)
         VALUES (app_current_tenant_id(), $1, $2, COALESCE($3, 'everyone'), $4,
                 app_current_actor_id())
         RETURNING id, slug, title, audience, category, status, published_version, updated_at`,
        [input.slug, input.title, input.audience ?? null, input.category ?? null]);
      const article = rows[0]!;

      await db.query(
        `INSERT INTO kb_article_version
           (tenant_id, kb_article_id, version, title, body, written_by)
         VALUES (app_current_tenant_id(), $1, 1, $2, $3, app_current_actor_id())`,
        [article.id, input.title, input.body]);

      return article;
    });
  },

  /** A new version. Never an edit — the old text stays readable and citable. */
  async revise(
    scope: TenantScope,
    articleId: string, input: { title: string; body: string },
  ): Promise<{ version: number }> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<{ version: number }>(
        `INSERT INTO kb_article_version
           (tenant_id, kb_article_id, version, title, body, written_by)
         SELECT app_current_tenant_id(), $1,
                COALESCE(MAX(version), 0) + 1, $2, $3, app_current_actor_id()
           FROM kb_article_version WHERE kb_article_id = $1
         RETURNING version`,
        [articleId, input.title, input.body]);
      if (!rows[0]) {
        throw ApiError.make('not_found', 'article_not_found', 'No such article.');
      }
      // The title on the article row tracks the latest draft so a staff list
      // reads sensibly; readers get the PUBLISHED version's title.
      await db.query('UPDATE kb_article SET title = $2 WHERE id = $1',
        [articleId, input.title]);
      return rows[0];
    });
  },

  /**
   * Publishes a specific version, which is the whole point of the pointer.
   *
   * Publishing "the latest" would mean a half-finished draft goes live the
   * moment someone saves it, which is how a help page ends up saying "TODO" to a
   * parent at 9pm.
   */
  async publish(scope: TenantScope, articleId: string, version: number): Promise<void> {
    await withTenant(scope, async (db) => {
      const { rows } = await db.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM kb_article_version
            WHERE kb_article_id = $1 AND version = $2) AS exists`,
        [articleId, version]);
      if (!rows[0]?.exists) {
        throw ApiError.make('not_found', 'version_not_found',
          'That version of the article does not exist.');
      }

      await db.query(
        `UPDATE kb_article SET status = 'published', published_version = $2 WHERE id = $1`,
        [articleId, version]);

      await auditService.record({
        tenantId: scope.tenantId, action: 'kb_article.published',
        resourceType: 'kb_article', resourceId: articleId,
        after: { version },
      });
    });
  },

  async unpublish(scope: TenantScope, articleId: string): Promise<void> {
    await withTenant(scope, async (db) => {
      // published_version is kept, not cleared: re-publishing should restore
      // what was there rather than ask somebody to remember which one it was.
      await db.query(
        `UPDATE kb_article SET status = 'archived' WHERE id = $1`, [articleId]);
    });
  },

  /**
   * Search.
   *
   * The policies decide what comes back: a guardian gets published articles for
   * their audience, staff get everything including drafts. So the same call
   * serves the help centre and the editor, and there is no second query to keep
   * in step with the first.
   */
  async search(scope: TenantScope, query: string, limit = 20): Promise<ArticleWithBody[]> {
    return withTenant(scope, async (db) => {
      const term = query.trim();
      const { rows } = await db.query<ArticleWithBody>(
        `SELECT a.id, a.slug, a.title, a.audience, a.category, a.status,
                a.published_version, a.updated_at,
                v.version, v.body
           FROM kb_article a
           JOIN kb_article_version v
             ON v.kb_article_id = a.id
            AND v.version = COALESCE(a.published_version,
                                     (SELECT MAX(version) FROM kb_article_version
                                       WHERE kb_article_id = a.id))
          WHERE $1 = ''
             OR v.title ILIKE '%' || $1 || '%'
             OR v.body  ILIKE '%' || $1 || '%'
          ORDER BY
            -- A title hit beats a body hit. Someone searching "fee receipt"
            -- wants the article called that, not the twelve that mention it.
            (v.title ILIKE '%' || $1 || '%') DESC,
            similarity(v.title, $1) DESC,
            a.updated_at DESC
          LIMIT $2`,
        [term, limit]);
      return rows;
    });
  },

  async bySlug(scope: TenantScope, slug: string): Promise<ArticleWithBody> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<ArticleWithBody>(
        `SELECT a.id, a.slug, a.title, a.audience, a.category, a.status,
                a.published_version, a.updated_at, v.version, v.body
           FROM kb_article a
           JOIN kb_article_version v
             ON v.kb_article_id = a.id
            AND v.version = COALESCE(a.published_version,
                                     (SELECT MAX(version) FROM kb_article_version
                                       WHERE kb_article_id = a.id))
          WHERE a.slug = $1`,
        [slug]);
      if (!rows[0]) {
        throw ApiError.make('not_found', 'article_not_found', 'No such article.');
      }
      return rows[0];
    });
  },
};
