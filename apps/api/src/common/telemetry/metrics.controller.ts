/**
 * The scrape endpoint.
 *
 * Deliberately NOT on the public API surface and NOT behind the ordinary auth
 * guard. A Prometheus scraper has no session and no tenant; making it
 * authenticate through the school login would mean a service account with a
 * password in a config file, which is worse than the thing it protects.
 *
 * What protects it instead is the network: this binds on the same port as
 * everything else, so in a real deployment the path is blocked at the load
 * balancer and reachable only inside the private subnet. That is a deployment
 * fact rather than a code fact, so it is stated here AND enforced there — M22
 * has the rule, and this comment exists so nobody removes it believing the code
 * is what was guarding this.
 *
 * Nothing here is tenant data. Every series is service-wide, by construction
 * (see metrics.ts), so a leak would disclose request volume and error rates —
 * embarrassing, not dangerous. That is the reason the trade is acceptable, and
 * it stops being acceptable the day somebody adds a tenant label.
 */
import { Controller, Get, Header } from '@nestjs/common';
import { Public } from '../../modules/auth/public.decorator.ts';
import { registry } from './metrics.ts';
import { sampleGauges } from './gauges.ts';

@Controller()
export class MetricsController {
  @Public()
  @Get('metrics')
  @Header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
  async metrics(): Promise<string> {
    // Sampled at scrape time rather than on a timer: a backlog gauge updated
    // by its own interval keeps reporting a stale number when the thing that
    // updates it is the thing that has stopped.
    await sampleGauges();
    return registry.metrics();
  }
}
