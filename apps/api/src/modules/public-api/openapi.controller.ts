import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/public.decorator.ts';
import { buildSpec } from '../../openapi/spec.ts';

/**
 * The spec, served unauthenticated.
 *
 * Deliberately public: an integrator reads the contract before they have a key,
 * and making them ask us for one first is how a "self-serve API" acquires a
 * sales call. It describes shapes, not data — there is nothing here that a
 * tenant could leak.
 *
 * Built on each request rather than read from disk, so the served spec and the
 * running code cannot be different versions of the truth.
 */
@Public()
@Controller('api/v1/openapi.json')
export class OpenApiController {
  @Get()
  spec(): Record<string, unknown> {
    return buildSpec();
  }
}
