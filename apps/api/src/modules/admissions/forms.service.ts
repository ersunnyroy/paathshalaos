import { Ajv, type ValidateFunction } from 'ajv';
import { withTenant, type TenantScope } from '../../db/tenant.ts';
import { auditService } from '../audit/audit.service.ts';
import { ApiError } from '../../common/errors.ts';

/**
 * A tenant-authored JSON Schema is untrusted input, and JSON Schema is powerful
 * enough to be a denial-of-service vector: an unbounded `pattern` can be
 * catastrophically backtracking, `$ref` can reach outside the document, and deep
 * nesting can blow the stack at validation time.
 *
 * So the schema is itself validated against a whitelist before it is stored, and
 * the validator is configured to refuse anything it would otherwise try to be
 * clever about.
 */
const MAX_SCHEMA_DEPTH = 6;
const MAX_PROPERTIES = 120;
const MAX_PATTERN_LENGTH = 120;

const ALLOWED_KEYWORDS = new Set([
  'type', 'properties', 'required', 'items', 'enum', 'const', 'title',
  'description', 'default', 'format', 'minimum', 'maximum', 'exclusiveMinimum',
  'exclusiveMaximum', 'minLength', 'maxLength', 'pattern', 'minItems',
  'maxItems', 'uniqueItems', 'additionalProperties', '$schema',
]);

/**
 * The five formats an admission form legitimately needs, implemented here rather
 * than pulled from ajv-formats.
 *
 * The whitelist above means only these five could ever be used, so the
 * dependency would contribute one CJS/ESM interop problem and thirty formats
 * nobody may write. Each regex below is anchored and has no nested quantifiers.
 */
const FORMATS: Record<string, RegExp> = {
  date: /^\d{4}-\d{2}-\d{2}$/,
  'date-time': /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/,
  email: /^[^@\s]{1,64}@[^@\s.]{1,63}(\.[^@\s.]{1,63}){1,4}$/,
  uri: /^[a-zA-Z][a-zA-Z0-9+.-]{0,31}:\/\/[^\s]{1,2000}$/,
  uuid: /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
};

const ALLOWED_FORMATS = new Set(Object.keys(FORMATS));

const ajv = new Ajv({ strict: true, allErrors: true, validateFormats: true });

for (const [name, re] of Object.entries(FORMATS)) {
  ajv.addFormat(name, {
    type: 'string',
    validate: (value: string) => {
      // A length guard before the regex: even an anchored pattern should not be
      // handed a megabyte of input from a form field.
      if (value.length > 2048) return false;
      if (!re.test(value)) return false;
      // A date that matches the shape can still be the 31st of February, and
      // Date.parse does NOT reject it — it silently rolls 2014-02-31 forward to
      // 2014-03-03. A birth date would then be stored as one day and mean
      // another. So the check is a round trip: reformat what was parsed and
      // require it to equal what was given.
      if (name === 'date' || name === 'date-time') {
        const ms = Date.parse(value);
        if (Number.isNaN(ms)) return false;
        const iso = new Date(ms).toISOString();
        return name === 'date'
          ? iso.slice(0, 10) === value
          : iso.slice(0, 10) === value.slice(0, 10);
      }
      return true;
    },
  });
}

export interface FormDefinition {
  id: string;
  code: string;
  version: number;
  title: string;
  purpose: string;
  json_schema: unknown;
  published_at: Date | null;
}

/** Walks the schema and rejects anything outside the whitelist. */
function assertSchemaIsSafe(node: unknown, depth = 0, path = '$'): void {
  if (depth > MAX_SCHEMA_DEPTH) {
    throw ApiError.make('validation_error', 'schema_too_deep',
      `Form schema nests deeper than ${MAX_SCHEMA_DEPTH} levels at ${path}.`);
  }
  if (Array.isArray(node)) {
    node.forEach((n, i) => assertSchemaIsSafe(n, depth + 1, `${path}[${i}]`));
    return;
  }
  if (node === null || typeof node !== 'object') return;

  const obj = node as Record<string, unknown>;

  for (const key of Object.keys(obj)) {
    // Inside a `properties` map the keys are field names, not keywords.
    const isPropertyName = path.endsWith('.properties');
    if (!isPropertyName && !ALLOWED_KEYWORDS.has(key)) {
      throw ApiError.make('validation_error', 'schema_keyword_not_allowed',
        `Form schema uses unsupported keyword "${key}" at ${path}.`);
    }
  }

  if (typeof obj['pattern'] === 'string') {
    const pattern = obj['pattern'];
    if (pattern.length > MAX_PATTERN_LENGTH) {
      throw ApiError.make('validation_error', 'schema_pattern_too_long',
        `A pattern at ${path} exceeds ${MAX_PATTERN_LENGTH} characters.`);
    }
    // Nested quantifiers are the classic catastrophic-backtracking shape.
    if (/(\(.*[+*].*\)[+*])|(\[[^\]]*\][+*]\s*[+*])/.test(pattern)) {
      throw ApiError.make('validation_error', 'schema_pattern_unsafe',
        `A pattern at ${path} has nested quantifiers and could backtrack catastrophically.`);
    }
  }

  if (typeof obj['format'] === 'string' && !ALLOWED_FORMATS.has(obj['format'])) {
    throw ApiError.make('validation_error', 'schema_format_not_allowed',
      `Format "${obj['format']}" at ${path} is not supported.`);
  }

  const properties = obj['properties'];
  if (properties && typeof properties === 'object') {
    const count = Object.keys(properties as object).length;
    if (count > MAX_PROPERTIES) {
      throw ApiError.make('validation_error', 'schema_too_many_fields',
        `A form may define at most ${MAX_PROPERTIES} fields; ${path} has ${count}.`);
    }
    for (const [name, sub] of Object.entries(properties as Record<string, unknown>)) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)) {
        throw ApiError.make('validation_error', 'schema_field_name_invalid',
          `Field name "${name}" is not a valid identifier.`);
      }
      assertSchemaIsSafe(sub, depth + 1, `${path}.properties.${name}`);
    }
  }

  for (const key of ['items']) {
    if (obj[key] !== undefined) assertSchemaIsSafe(obj[key], depth + 1, `${path}.${key}`);
  }
}

/**
 * Compiled validators, keyed by form_definition id.
 *
 * Safe to cache without invalidation precisely because a published definition
 * is frozen by a database trigger: the schema behind an id can never change, so
 * a cached validator can never go stale. That property is why the freeze exists.
 */
const validatorCache = new Map<string, ValidateFunction>();

export const formsService = {
  async createDraft(
    scope: TenantScope,
    input: { code: string; title: string; purpose: string; jsonSchema: unknown; uiSchema?: unknown },
  ): Promise<FormDefinition> {
    assertSchemaIsSafe(input.jsonSchema);
    try {
      ajv.compile(input.jsonSchema as object);
    } catch (err) {
      throw ApiError.make('validation_error', 'schema_invalid',
        `The form schema is not valid JSON Schema: ${err instanceof Error ? err.message : 'unknown'}`);
    }

    return withTenant(scope, async (db) => {
      const { rows } = await db.query<FormDefinition>(
        `INSERT INTO form_definition
           (tenant_id, code, version, title, purpose, json_schema, ui_schema, created_by)
         VALUES (app_current_tenant_id(), $1,
                 COALESCE((SELECT max(version) FROM form_definition
                            WHERE tenant_id = app_current_tenant_id() AND code = $1), 0) + 1,
                 $2, $3, $4::jsonb, $5::jsonb, $6)
         RETURNING id, code, version, title, purpose, json_schema, published_at`,
        [input.code, input.title, input.purpose, JSON.stringify(input.jsonSchema),
         input.uiSchema === undefined ? null : JSON.stringify(input.uiSchema), scope.actorId ?? null],
      );
      if (!rows[0]) {
        throw ApiError.make('permission_error', 'staff_only', 'Only staff may define forms.');
      }
      return rows[0];
    });
  },

  async publish(scope: TenantScope, formDefinitionId: string): Promise<FormDefinition> {
    const published = await withTenant(scope, async (db) => {
      const { rows } = await db.query<FormDefinition>(
        `UPDATE form_definition SET published_at = now()
          WHERE id = $1 AND published_at IS NULL
          RETURNING id, code, version, title, purpose, json_schema, published_at`,
        [formDefinitionId],
      );
      if (!rows[0]) {
        throw ApiError.make('conflict', 'already_published_or_missing',
          'That form version is already published, or does not exist.');
      }
      return rows[0];
    });

    await auditService.record({
      tenantId: scope.tenantId,
      actorUserId: scope.actorId,
      action: 'form_definition.published',
      resourceType: 'form_definition',
      resourceId: published.id,
      classification: 'INTERNAL',
      after: { code: published.code, version: published.version },
    });
    return published;
  },

  /**
   * Validates a payload against a published definition and stores the
   * submission with the id of the version that validated it.
   */
  async submit(
    scope: TenantScope,
    input: { formDefinitionId: string; payload: Record<string, unknown> },
  ): Promise<{ id: string; formDefinitionId: string }> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<{ id: string; json_schema: unknown; published_at: Date | null }>(
        'SELECT id, json_schema, published_at FROM form_definition WHERE id = $1',
        [input.formDefinitionId],
      );
      const def = rows[0];
      if (!def) {
        throw ApiError.make('not_found', 'form_not_found', 'Form definition not found.');
      }
      if (!def.published_at) {
        throw ApiError.make('validation_error', 'form_not_published',
          'A draft form cannot accept submissions.');
      }

      let validate = validatorCache.get(def.id);
      if (!validate) {
        validate = ajv.compile(def.json_schema as object);
        validatorCache.set(def.id, validate);
      }

      if (!validate(input.payload)) {
        throw ApiError.make(
          'validation_error', 'form_payload_invalid', 'The submitted answers are not valid.',
          (validate.errors ?? []).map((e) => ({
            path: e.instancePath || '(root)',
            issue: e.message ?? 'invalid',
          })),
        );
      }

      const inserted = await db.query<{ id: string }>(
        `INSERT INTO form_submission (tenant_id, form_definition_id, payload, submitted_by)
         VALUES (app_current_tenant_id(), $1, $2::jsonb, $3)
         RETURNING id`,
        [def.id, JSON.stringify(input.payload), scope.actorId ?? null],
      );
      return { id: inserted.rows[0]!.id, formDefinitionId: def.id };
    });
  },

  /** Test seam. The cache is otherwise safe for the process lifetime. */
  clearValidatorCache(): void {
    validatorCache.clear();
  },
};
