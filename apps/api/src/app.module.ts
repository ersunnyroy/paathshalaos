import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_GUARD, APP_FILTER } from '@nestjs/core';
import { ContextMiddleware } from './common/context.middleware.ts';
import { AccessLogMiddleware } from './common/telemetry/access-log.middleware.ts';
import { ErrorFilter } from './common/error.filter.ts';
import { MetricsController } from './common/telemetry/metrics.controller.ts';
import { AuthGuard } from './modules/auth/auth.guard.ts';
import { AuthController } from './modules/auth/auth.controller.ts';
import { HealthController } from './modules/health/health.controller.ts';
import { TenancyController } from './modules/tenancy/tenancy.controller.ts';
import { ReportingController } from './modules/reporting/reporting.controller.ts';
import { DirectoryController } from './modules/reporting/directory.controller.ts';
import { IntegrationsController } from './modules/public-api/integrations.controller.ts';
import { PublicApiController } from './modules/public-api/public.controller.ts';
import { SupportController } from './modules/support/support.controller.ts';
import { OpenApiController } from './modules/public-api/openapi.controller.ts';
import { PlatformController } from './modules/platform/platform.controller.ts';
import { ReadOnlyEntryGuard } from './modules/platform/read-only-entry.guard.ts';
import { AccessLogController } from './modules/platform/access-log.controller.ts';
import { EntitlementGuard } from './modules/billing-plans/entitlement.guard.ts';
import { PlanController } from './modules/billing-plans/plan.controller.ts';
import { BrandController, BrandingSettingsController }
  from './modules/branding/brand.controller.ts';
import { TransportController } from './modules/transport/transport.controller.ts';
import { LearningController } from './modules/learning/learning.controller.ts';
import { HrController } from './modules/hr/hr.controller.ts';
import {
  AdmissionsController, EnrollmentController,
} from './modules/admissions/admissions.controller.ts';
import { BillingController } from './modules/billing/billing.controller.ts';
import { MessagingController } from './modules/messaging/messaging.controller.ts';
import { ImportController } from './modules/import/import.controller.ts';
import { FamilyController } from './modules/family/family.controller.ts';

@Module({
  controllers: [
    HealthController, AuthController, TenancyController,
    ReportingController, DirectoryController,
    IntegrationsController, PublicApiController, SupportController,
    OpenApiController, PlatformController, AccessLogController, PlanController,
    BrandController, BrandingSettingsController, TransportController,
    LearningController, HrController,
    AdmissionsController, EnrollmentController, BillingController,
    MessagingController, ImportController,
    FamilyController, MetricsController,
  ],
  providers: [
    // Every failure gets the contract's shape, including a bare throw.
    { provide: APP_FILTER, useClass: ErrorFilter },
    // Registered globally, so a new controller is authenticated by default and
    // has to opt out with @Public() rather than opt in. The failure mode of
    // forgetting is a locked door, not an open one.
    { provide: APP_GUARD, useClass: AuthGuard },
    // Order matters: Nest runs global guards in registration order, and this
    // one reads what AuthGuard put in the request context.
    { provide: APP_GUARD, useClass: ReadOnlyEntryGuard },
    // Last: it asks the database a question, so it runs only for requests that
    // have already proved who they are and which school they are in.
    { provide: APP_GUARD, useClass: EntitlementGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Context first: the access log reads the request id out of it, and both
    // must wrap the whole request so a guard's refusal is still timed and
    // still logged. Middleware runs before guards; an interceptor does not,
    // which is why this is not one.
    consumer.apply(ContextMiddleware, AccessLogMiddleware).forRoutes('*');
  }
}
