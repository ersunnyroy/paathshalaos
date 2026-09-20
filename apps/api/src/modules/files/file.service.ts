/**
 * The file lifecycle: ask, upload, scan, serve, erase (M37).
 *
 * Before this, nothing in this product inserted a row into `file`. The table
 * has existed since 0017 with a bucket, a digest, a scan state and a legal
 * hold; `application_document` references it; M36's admissions test had to
 * insert one by hand to have anything to attach. A school could not upload a
 * birth certificate.
 *
 * ## The digest comes from the client, and is then checked
 *
 * `requestUpload` takes a sha256 the caller computed. That is not trust — it
 * is how content addressing gets to be useful at all. The same document
 * uploaded twice is one row and one object (0017's `file_tenant_sha256_key`),
 * and the only way to know that *before* spending the upload is to be told the
 * digest.
 *
 * It is verified on the way back, in `confirmUpload`, against the bytes
 * actually in the store. A caller who lies has their row refused and the
 * object removed. The window in between is a presigned PUT to a key derived
 * from the claimed digest inside the caller's own tenant prefix, which is worth
 * being precise about: the worst it buys is occupying one key in their own
 * school's namespace with bytes that do not match it.
 *
 * ## Scanning happens here, not in the browser's request
 *
 * The PUT went straight from the browser to the store, so `confirmUpload` is
 * the first moment this system has ever seen the bytes. It reads them once and
 * both hashes and scans that one buffer — reading twice would let a file pass
 * the digest check and be scanned as something else, which is the whole trick
 * behind a time-of-check/time-of-use swap.
 */
import { createHash } from 'node:crypto';
import { withTenant, type TenantScope, type TenantClient } from '../../db/tenant.ts';
import { ApiError } from '../../common/errors.ts';
import { auditService } from '../audit/audit.service.ts';
import { objectStore, storageNotConfigured, type ObjectStore }
  from '../../storage/object-store.ts';
import { objectKey } from '../../storage/keys.ts';
import { scanner } from '../../storage/scanner.ts';

export type Classification = 'PUBLIC' | 'INTERNAL' | 'SENSITIVE' | 'RESTRICTED';

export interface FileRow {
  id: string;
  bucket: string;
  object_key: string;
  mime_type: string;
  size_bytes: string;
  sha256: string;
  classification: string;
  virus_scan_state: string;
  legal_hold: boolean;
  original_filename: string | null;
  deleted_at: string | null;
  erased_at: string | null;
}

const SELECT_FILE = `id, bucket, object_key, mime_type, size_bytes::text,
  sha256, classification, virus_scan_state, legal_hold, original_filename,
  deleted_at::text, erased_at::text`;

export const fileService = {
  /**
   * Reserves a row and hands back a URL to PUT the bytes to.
   *
   * Returns the existing row, and no URL, when this tenant already holds a
   * live file with the same digest. Re-uploading is not an error and not a
   * second object: a school attaching the same transfer certificate to a
   * sibling's application is the ordinary case, and answering "already exists"
   * would make them rename it and upload it anyway.
   */
  async requestUpload(
    scope: TenantScope,
    input: {
      filename: string; mimeType: string; sizeBytes: number; sha256: string;
      classification?: Classification | undefined;
    },
  ): Promise<{
    file: FileRow;
    upload?: { url: string; headers: Record<string, string>; expiresIn: number };
  }> {
    const store = objectStore();
    if (!store.bucket) storageNotConfigured();

    const sha = input.sha256.toLowerCase();
    const key = objectKey(scope.tenantId, sha);

    return withTenant(scope, async (db) => {
      const existing = await db.query<FileRow>(
        `SELECT ${SELECT_FILE} FROM file WHERE sha256 = $1 AND deleted_at IS NULL`,
        [sha]);
      if (existing.rows[0]) return { file: existing.rows[0] };

      let rows: FileRow[];
      try {
        ({ rows } = await db.query<FileRow>(
          `INSERT INTO file
             (tenant_id, bucket, object_key, mime_type, size_bytes, sha256,
              classification, uploaded_by, original_filename)
           VALUES (app_current_tenant_id(), $1, $2, $3, $4, $5,
                   COALESCE($6, 'INTERNAL'), app_current_actor_id(), $7)
           RETURNING ${SELECT_FILE}`,
          [store.bucket, key, input.mimeType, input.sizeBytes, sha,
           input.classification ?? null, input.filename]));
      } catch (err: unknown) {
        // `file` is staff-only under 0020 and the policy refuses by RAISING.
        // Handled for the reason M36 had to handle it twice: the empty-result
        // branch below reads like the refusal and cannot run.
        if ((err as { code?: string }).code === '42501') {
          throw ApiError.make('permission_error', 'staff_only',
            'Only institute staff may upload files.');
        }
        throw err;
      }
      const file = rows[0];
      if (!file) {
        throw ApiError.make('permission_error', 'staff_only',
          'Only institute staff may upload files.');
      }

      return {
        file,
        upload: await store.presignUpload({
          key, contentType: input.mimeType, sizeBytes: input.sizeBytes,
        }),
      };
    });
  },

  /**
   * Checks the bytes arrived, that they are what was promised, and scans them.
   *
   * Four things can be wrong and each gets its own answer, because "upload
   * failed" is the message that makes somebody try the same file six times:
   * the object is not there, it is the wrong size, its digest does not match,
   * or it is infected.
   *
   * A file that fails the digest check is removed from the store. A file that
   * fails the SCAN is not: the row is marked infected and the bytes stay until
   * the ordinary erasure path takes them, because "what exactly did somebody
   * try to upload" is a question an incident asks and an immediate delete
   * answers with nothing.
   */
  async confirmUpload(scope: TenantScope, fileId: string): Promise<FileRow> {
    const store = objectStore();
    if (!store.bucket) storageNotConfigured();

    const file = await fileService.byId(scope, fileId);
    if (!file) throw ApiError.make('not_found', 'file_not_found', 'No such file.');
    if (file.virus_scan_state === 'clean' || file.virus_scan_state === 'infected') {
      throw ApiError.make('conflict', 'already_confirmed',
        'That upload has already been checked.');
    }

    const head = await store.head(file.object_key);
    if (!head) {
      throw ApiError.make('conflict', 'nothing_uploaded',
        'The bytes have not arrived yet. Finish the upload, then confirm it.');
    }
    if (String(head.sizeBytes) !== file.size_bytes) {
      await store.remove(file.object_key);
      await markScan(scope, file.id, 'failed');
      throw ApiError.make('validation_error', 'size_mismatch',
        `The upload is ${head.sizeBytes} bytes and ${file.size_bytes} were declared.`);
    }

    const bytes = await readAll(store, file.object_key);
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== file.sha256) {
      await store.remove(file.object_key);
      await markScan(scope, file.id, 'failed');
      throw ApiError.make('validation_error', 'digest_mismatch',
        'The uploaded bytes do not match the checksum that was declared.');
    }

    const verdict = await scanner().scan(bytes);
    const state = verdict.state === 'clean' ? 'clean'
      : verdict.state === 'infected' ? 'infected' : 'pending';
    const updated = await markScan(scope, file.id, state);

    if (verdict.state === 'infected') {
      await auditService.record({
        tenantId: scope.tenantId,
        actorUserId: scope.actorId,
        action: 'file.infected',
        resourceType: 'file',
        resourceId: file.id,
        classification: 'RESTRICTED',
        after: { signature: verdict.signature, filename: file.original_filename },
        reason: `Refused: ${verdict.signature}`,
      });
      throw ApiError.make('validation_error', 'file_infected',
        `That file was refused: ${verdict.signature}.`);
    }
    if (verdict.state === 'failed') {
      // Left pending, deliberately. A scanner that is down must not become a
      // clean file, and the row stays visible to the job that counts them.
      throw ApiError.make('conflict', 'scan_unavailable',
        `The file was stored but could not be checked (${verdict.reason}), so it `
        + 'will not be served yet.');
    }
    return updated;
  },

  /** One file's record. Never the bytes. */
  async byId(scope: TenantScope, fileId: string): Promise<FileRow | undefined> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<FileRow>(
        `SELECT ${SELECT_FILE} FROM file WHERE id = $1::uuid`, [fileId]);
      return rows[0];
    });
  },

  /**
   * A URL to fetch the bytes, if the file has been cleared.
   *
   * A deleted file and an unknown one answer the same way, because a 404 that
   * becomes a 409 tells somebody the id was real.
   */
  async presignDownload(
    scope: TenantScope, fileId: string,
  ): Promise<{ url: string; expiresIn: number; filename: string }> {
    const store = objectStore();
    if (!store.bucket) storageNotConfigured();

    const file = await fileService.byId(scope, fileId);
    if (!file || file.deleted_at !== null) {
      throw ApiError.make('not_found', 'file_not_found', 'No such file.');
    }
    if (file.virus_scan_state !== 'clean') {
      throw ApiError.make('conflict', 'not_cleared',
        file.virus_scan_state === 'infected'
          ? 'That file was refused by the virus scanner and will not be served.'
          : 'That file has not been checked yet, so it will not be served.');
    }

    const filename = file.original_filename ?? file.sha256.slice(0, 12);
    const { url, expiresIn } = await store.presignDownload({
      key: file.object_key, filename, contentType: file.mime_type,
    });

    await auditService.record({
      tenantId: scope.tenantId,
      actorUserId: scope.actorId,
      action: 'file.downloaded',
      resourceType: 'file',
      resourceId: file.id,
      // Audited when the URL is issued, not when it is followed. A signed URL
      // IS the capability; handing it over is the act.
      classification: file.classification === 'RESTRICTED' ? 'RESTRICTED' : 'SENSITIVE',
    });
    return { url, expiresIn, filename };
  },

  /**
   * Marks a file deleted. The bytes go later, on the sweep.
   *
   * Not an immediate object delete, and not because it is easier: a delete
   * inside the request cannot be rolled back if the transaction that marked the
   * row then fails, and the row would come back pointing at nothing. Marking is
   * transactional; erasing is a job that can be repeated.
   */
  async softDelete(scope: TenantScope, fileId: string, reason: string): Promise<void> {
    const deleted = await withTenant(scope, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `UPDATE file SET deleted_at = now()
          WHERE id = $1::uuid AND deleted_at IS NULL AND legal_hold = false
          RETURNING id`,
        [fileId]);
      if (rows[0]) return rows[0];

      // Distinguished, because "under legal hold" is an answer and "not found"
      // is a different one, and a school told the wrong one during litigation
      // has a problem.
      const { rows: found } = await db.query<{ legal_hold: boolean }>(
        'SELECT legal_hold FROM file WHERE id = $1::uuid AND deleted_at IS NULL',
        [fileId]);
      if (found[0]?.legal_hold) {
        throw ApiError.make('conflict', 'under_legal_hold',
          'That file is under legal hold and cannot be deleted.');
      }
      throw ApiError.make('not_found', 'file_not_found', 'No such file.');
    });

    await auditService.record({
      tenantId: scope.tenantId,
      actorUserId: scope.actorId,
      action: 'file.deleted',
      resourceType: 'file',
      resourceId: deleted.id,
      classification: 'SENSITIVE',
      reason,
    });
  },

  /**
   * The erasure sweep: the bytes behind rows marked deleted.
   *
   * Takes a client rather than a scope because the scheduled job runs it on the
   * maintenance connection — `file` is staff-only, a job has no actor, and
   * through `withTenant` this query sees nothing and reports success. That is
   * the M33 lesson, stated once more where it applies.
   *
   * The row is not deleted when its bytes are. A retention policy has to be
   * able to show that something was there and is not, and a sweep that removed
   * rows could not tell "erased" from "never existed".
   */
  async eraseDeleted(
    db: TenantClient, tenantId: string, opts: { limit?: number } = {},
  ): Promise<{ erased: number; failed: number; bytes: number }> {
    const store = objectStore();
    if (!store.bucket) return { erased: 0, failed: 0, bytes: 0 };

    const { rows } = await db.query<{
      id: string; object_key: string; size_bytes: string;
    }>(
      `SELECT id, object_key, size_bytes::text
         FROM file
        WHERE tenant_id = $1::uuid
          AND deleted_at IS NOT NULL
          AND legal_hold = false
          AND erased_at IS NULL
        ORDER BY deleted_at
        LIMIT $2`,
      [tenantId, Math.min(opts.limit ?? 500, 2000)]);

    let erased = 0;
    let failed = 0;
    let bytes = 0;
    for (const row of rows) {
      try {
        await store.remove(row.object_key);
        await db.query('UPDATE file SET erased_at = now() WHERE id = $1::uuid', [row.id]);
        erased += 1;
        bytes += Number(row.size_bytes);
      } catch {
        // One object the store will not delete must not stop the other four
        // hundred. The row keeps `erased_at IS NULL` and the next run tries
        // again, which is why `remove` treats a missing key as success.
        failed += 1;
      }
    }
    return { erased, failed, bytes };
  },
};

async function markScan(
  scope: TenantScope, fileId: string, state: string,
): Promise<FileRow> {
  return withTenant(scope, async (db) => {
    const { rows } = await db.query<FileRow>(
      `UPDATE file SET virus_scan_state = $2, scanned_at = now()
        WHERE id = $1::uuid RETURNING ${SELECT_FILE}`,
      [fileId, state]);
    if (!rows[0]) throw ApiError.make('not_found', 'file_not_found', 'No such file.');
    return rows[0];
  });
}

/**
 * The whole object in memory.
 *
 * Bounded at the point the upload was signed — the store refuses a PUT whose
 * length does not match the signed `Content-Length`, and that length is capped
 * by `OBJECT_STORE_MAX_BYTES` — so this cannot be handed a file larger than the
 * deployment agreed to accept. Streaming to clamd without buffering would be
 * kinder to memory for the largest files and would mean hashing a second read,
 * which is the trade `confirmUpload` explains why it will not make.
 */
async function readAll(store: ObjectStore, key: string): Promise<Uint8Array> {
  const { url } = await store.presignDownload({
    key, filename: 'scan', contentType: 'application/octet-stream' });
  const res = await fetch(url);
  if (!res.ok) {
    throw ApiError.make('conflict', 'unreadable',
      `The store returned ${res.status} for an object it had just accepted.`);
  }
  return new Uint8Array(await res.arrayBuffer());
}
