/**
 * Uploading and downloading a file (M37).
 *
 * Three calls, not one, and the shape is the point:
 *
 *   POST /v1/files            "I have a 2MB PDF whose sha256 is …"  → a URL
 *   PUT  <the signed URL>      the browser sends the bytes to the store
 *   POST /v1/files/:id/confirm "it is up"                           → checked
 *
 * A single multipart endpoint would be one call and would put every byte of
 * every admission scan through this Node process. On the first Monday of April
 * that is four hundred multi-megabyte bodies sharing an event loop with the
 * attendance register at 8:45am. The store is built for that traffic and the
 * API is not, so the API signs and steps out of the way.
 *
 * The cost is that a client can walk away between step two and step three,
 * leaving a row `pending` with bytes behind it. That is visible — the scan
 * backlog job counts exactly this — and it is recoverable, because confirm is
 * safe to call late. An unbounded upload path through the API would not be
 * either.
 */
import { Controller, Get, Post, Body, Param } from '@nestjs/common';
import { z } from 'zod';
import { fileService } from './file.service.ts';
import { storageIsConfigured } from '../../storage/object-store.ts';
import { scanner } from '../../storage/scanner.ts';
import { loadEnv } from '../../config/env.ts';
import { currentScope } from '../../common/scope.ts';
import { ApiError } from '../../common/errors.ts';

const uuid = z.string().uuid();

@Controller('v1/files')
export class FileController {
  /**
   * What this deployment can actually do with files.
   *
   * A client that has to guess whether uploads work will guess by trying one,
   * which means a person picks a file and waits before being told. Saying it
   * up front also makes the missing scanner visible rather than something
   * discovered when the first download is refused.
   */
  @Get('capabilities')
  async capabilities() {
    const env = loadEnv();
    return {
      data: {
        storage: storageIsConfigured(),
        scanner: scanner().configured,
        maxBytes: env.OBJECT_STORE_MAX_BYTES,
        urlTtlSeconds: env.OBJECT_STORE_URL_TTL_SECONDS,
        // Stated rather than implied. Without a scanner every upload stays
        // pending and nothing is served, and a client should be able to warn
        // somebody before they spend ten minutes uploading.
        note: scanner().configured ? undefined
          : 'No virus scanner is configured, so uploads will be stored and '
            + 'will not be served until one is.',
      },
    };
  }

  @Post()
  async request(@Body() body: unknown) {
    const env = loadEnv();
    const parsed = z.object({
      filename: z.string().min(1).max(255),
      // Narrow on purpose. A store that serves whatever it is given is a
      // hosting provider for whatever somebody uploads, and the
      // `Content-Type` is signed into the URL so this is the value the store
      // will hold forever.
      mimeType: z.enum([
        'application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic',
        'text/csv', 'text/plain',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ]),
      sizeBytes: z.number().int().min(1).max(env.OBJECT_STORE_MAX_BYTES),
      // Lower-case hex, checked here because the key is derived from it and a
      // key derived from a malformed digest is a 500 from a helper rather than
      // a sentence naming the field.
      sha256: z.string().regex(/^[0-9a-f]{64}$/, 'sha256 must be 64 lower-case hex characters'),
      classification: z.enum(['PUBLIC', 'INTERNAL', 'SENSITIVE', 'RESTRICTED']).optional(),
    }).safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);

    return { data: await fileService.requestUpload(currentScope(), parsed.data) };
  }

  @Post(':id/confirm')
  async confirm(@Param('id') id: string) {
    const fileId = uuid.safeParse(id);
    if (!fileId.success) throw ApiError.fromZod(fileId.error);
    return { data: await fileService.confirmUpload(currentScope(), fileId.data) };
  }

  @Get(':id')
  async byId(@Param('id') id: string) {
    const fileId = uuid.safeParse(id);
    if (!fileId.success) throw ApiError.fromZod(fileId.error);
    const found = await fileService.byId(currentScope(), fileId.data);
    if (!found || found.deleted_at !== null) {
      throw ApiError.make('not_found', 'file_not_found', 'No such file.');
    }
    return { data: found };
  }

  /**
   * A short-lived URL for the bytes.
   *
   * A POST rather than a GET even though it reads: it issues a capability and
   * writes an audit row, and a GET that does both is one a browser will
   * prefetch and a proxy will cache.
   */
  @Post(':id/download-url')
  async downloadUrl(@Param('id') id: string) {
    const fileId = uuid.safeParse(id);
    if (!fileId.success) throw ApiError.fromZod(fileId.error);
    return { data: await fileService.presignDownload(currentScope(), fileId.data) };
  }

  /** Marks it deleted, with a reason. The bytes go on the nightly sweep. */
  @Post(':id/delete')
  async remove(@Param('id') id: string, @Body() body: unknown) {
    const fileId = uuid.safeParse(id);
    if (!fileId.success) throw ApiError.fromZod(fileId.error);
    const parsed = z.object({ reason: z.string().min(1).max(2000) }).safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    await fileService.softDelete(currentScope(), fileId.data, parsed.data.reason);
    return { data: { deleted: true } };
  }
}
