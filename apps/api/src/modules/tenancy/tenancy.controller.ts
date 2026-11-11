import { Controller, Get, Post, Body, Param, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { tenancyRepository } from './tenancy.repository.ts';
import { requireTenantId, getContext } from '../../common/request-context.ts';
import { ApiError } from '../../common/errors.ts';

const createCampusSchema = z.object({
  code: z.string().min(1).max(32).regex(/^[A-Z0-9_-]+$/i, 'code must be alphanumeric'),
  name: z.string().min(1).max(200),
  isPrimary: z.boolean().optional(),
});

@Controller('v1/campuses')
export class TenancyController {
  private scope() {
    const ctx = getContext();
    const actorId = ctx?.actorId;
    return { tenantId: requireTenantId(), ...(actorId ? { actorId } : {}) };
  }

  @Get()
  async list() {
    return { data: await tenancyRepository.listCampuses(this.scope()) };
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    const campus = await tenancyRepository.findCampusById(this.scope(), id);
    // A campus belonging to another tenant is indistinguishable from one that
    // does not exist. Returning 403 here would confirm the id is real.
    if (!campus) throw new NotFoundException(ApiError.notFound('campus_not_found', 'Campus not found.'));
    return { data: campus };
  }

  @Post()
  async create(@Body() body: unknown) {
    const parsed = createCampusSchema.safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return { data: await tenancyRepository.createCampus(this.scope(), parsed.data) };
  }
}
