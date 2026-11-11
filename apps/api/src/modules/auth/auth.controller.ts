import { Controller, Post, Body, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { authService } from './auth.service.ts';
import { Public } from './public.decorator.ts';
import { ApiError } from '../../common/errors.ts';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  tenantId: z.string().uuid(),
  device: z
    .object({
      platform: z.enum(['ios', 'android', 'web']),
      fingerprint: z.string().min(8).max(200),
      appVersion: z.string().max(40).optional(),
    })
    .optional(),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(20),
  tenantId: z.string().uuid(),
});

@Controller('v1/auth')
export class AuthController {
  @Public()
  @Post('login')
  async login(@Body() body: unknown, @Req() req: Request) {
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);

    const ip = req.ip;
    const userAgent = req.headers['user-agent'];
    return {
      data: await authService.login({
        ...parsed.data,
        ...(ip ? { ip } : {}),
        ...(typeof userAgent === 'string' ? { userAgent } : {}),
      }),
    };
  }

  @Public()
  @Post('refresh')
  async refresh(@Body() body: unknown) {
    const parsed = refreshSchema.safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return { data: await authService.refresh(parsed.data.refreshToken, parsed.data.tenantId) };
  }

  @Public()
  @Post('logout')
  async logout(@Body() body: unknown) {
    const parsed = z.object({ refreshToken: z.string().min(20) }).safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    await authService.logout(parsed.data.refreshToken);
    return { data: { ok: true } };
  }
}
