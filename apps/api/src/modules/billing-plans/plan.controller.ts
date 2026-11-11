/**
 * What a school can see about its own plan (M16.6, the API half).
 *
 * Read-only, and that is not an oversight — there is no self-serve upgrade
 * here. Taking money from schools is deliberately out of scope for M16, and an
 * endpoint that changes a plan without taking the money is an endpoint that
 * hands out free upgrades.
 *
 * Visible to any signed-in member of staff rather than gated on a permission:
 * "which plan are we on and how close to the limit" is the question a bursar
 * asks a fortnight before it becomes a crisis, and making them ask the owner is
 * how a school discovers its learner cap by hitting it.
 */
import { Controller, Get } from '@nestjs/common';
import { subscriptionService } from './subscription.service.ts';
import { currentScope } from '../../common/scope.ts';

@Controller('v1/plan')
export class PlanController {
  @Get()
  async mine() {
    const scope = currentScope();
    const subscription = await subscriptionService.forTenant(scope);
    const usage = subscription === null ? [] : await subscriptionService.usageForTenant(scope);
    return {
      data: subscription === null ? null : { ...subscription, usage },
      notice: subscription === null
        ? 'This school is not on a plan yet. Everything works; nothing is metered.'
        : subscription.status === 'read_only'
          ? 'New entries are paused while the account is past due. Everything '
            + 'already here can be read and exported, and nothing has been deleted.'
          : undefined,
    };
  }

  /** What else is on offer. Published, public plans only. */
  @Get('options')
  async options() {
    return { data: await subscriptionService.optionsForTenant(currentScope()) };
  }

  @Get('history')
  async history() {
    return { data: await subscriptionService.historyForTenant(currentScope()) };
  }
}
