import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { pool } from '../../db/pool.ts';
import { Public } from '../auth/public.decorator.ts';

interface Check {
  ok: boolean;
  detail?: string;
}

@Controller()
export class HealthController {
  /** Liveness: is the process up. Never touches a dependency. */
  @Public()
  @Get('health')
  health() {
    return { status: 'ok', uptime_seconds: Math.round(process.uptime()) };
  }

  /** Readiness: should this instance receive traffic. */
  @Public()
  @Get('ready')
  async ready() {
    const checks = {
      database: await this.checkDatabase(),
      migrations: await this.checkMigrations(),
    };
    const ok = Object.values(checks).every((c) => c.ok);

    if (!ok) throw new ServiceUnavailableException({ status: 'unavailable', checks });
    return { status: 'ready', checks };
  }

  private async checkDatabase(): Promise<Check> {
    try {
      await pool.query('SELECT 1');
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : 'unknown error' };
    }
  }

  /**
   * Readiness fails while migrations are pending, so a rolling deploy does not
   * send traffic to an instance whose schema is behind the code it is running.
   */
  private async checkMigrations(): Promise<Check> {
    try {
      const { rows } = await pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM schema_migration',
      );
      return Number(rows[0]?.count ?? 0) > 0
        ? { ok: true }
        : { ok: false, detail: 'no migrations applied' };
    } catch {
      return { ok: false, detail: 'schema_migration table unavailable' };
    }
  }
}
