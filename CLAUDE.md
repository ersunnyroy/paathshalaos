# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

PaathshalaOS is a multi-tenant SaaS platform for educational institutions. The repo is a monorepo with:
- `api/` — Laravel 12 REST API (PHP 8.2+)
- `frontend/` — Next.js 13 app (React 18, TypeScript)
- `template-react/` — UI component showcase/demo app

## Commands

### Backend (`api/`)

```bash
composer setup          # Full setup: install deps, generate key, migrate, build assets
composer run dev        # Start all services: HTTP server, queue worker, log viewer, Vite
php artisan serve       # HTTP server only (port 8000)
php artisan migrate     # Run database migrations
php artisan test        # Run all PHPUnit tests
php artisan test --filter TestName   # Run a single test
php artisan queue:listen             # Process queue jobs
```

### Frontend (`frontend/`)

```bash
npm install             # Install dependencies
npm run dev             # Dev server (port 3000)
npm run build           # Production build
npm run lint            # ESLint
npm run format          # Prettier
```

The Next.js config rewrites `/api/*` to the Laravel backend, so the frontend makes requests to its own origin and they get proxied with `X-Tenant-ID` headers forwarded automatically.

## Architecture

### Backend: Repository Pattern

Every feature follows this strict layering:

```
Controller → Service → Repository (Interface) → Repository (Eloquent impl) → Model
```

- **Controllers** (`app/Http/Controllers/Api/`): HTTP handling only — no business logic
- **Services** (`app/Services/`): All business logic lives here
- **Repositories** (`app/Repositories/Contracts/` + `app/Repositories/Eloquent/`): Data access via interfaces; always inject the interface, not the concrete class
- **Models** (`app/Models/`): Eloquent data entities only
- **Form Requests** (`app/Http/Requests/`): Validation
- **API Resources** (`app/Http/Resources/`): Response transformation — always use these, never `response()->json(['data' => $model])`

### Multi-Tenancy

Every database table (except global lookup tables) has a `tenant_id` column. Tenant isolation is enforced via middleware:

```
Request → TenantDetection middleware → AuthMiddleware → Controller
```

`TenantDetection` resolves the tenant by checking (in order): `X-Tenant-ID` header → custom domain → subdomain (e.g., `school-name.paathshala.local`). The tenant is then scoped to all subsequent queries via `TenantScope` middleware.

**Never hard-delete records** — use the `status` field for soft deletes.

### Redis Caching

Cache keys follow this convention:
```
tenant:{id}:features      # enabled features (JSON)
tenant:{id}:modules       # enabled modules (JSON)
user:{id}:permissions     # user permissions (array)
```

Invalidate cache on feature/module toggle and on permission changes.

### Frontend Structure

- `app/(auth)/` — Login, Register (unauthenticated routes)
- `app/(main)/` — Protected dashboard pages (authenticated)
- `lib/httpClient.ts` — Centralized HTTP client; auto-injects `Authorization: Bearer` token and `X-Tenant-ID` header
- `lib/apiConfig.ts` — All API endpoint definitions (parameterized URLs)
- `services/` — API call functions returning typed `ApiResponse<T>`
- `hooks/` — `useTenant` (tenant context), `useTheme` (light/dark toggle)

All API responses must match:
```typescript
interface ApiResponse<T> {
    success: boolean;
    message?: string;
    data?: T;
    errors?: Record<string, string[]>;
}
```

### UI Framework

PrimeReact is the component library. Theme: `lara-light-teal` / `lara-dark-teal`, toggled via localStorage with browser preference detection as default.

### File Storage Paths

Files are stored under tenant-scoped paths:
```
{tenant_id}/logos/logo
{tenant_id}/branches/{branch_id}/logo
{tenant_id}/users/{user_id}/avatar
```
Storage driver is `local` in dev, `minio` for local S3-compatible dev, `s3` for production.

## Key Conventions (MANDATORY)

- **Reference data** (countries, states, institute types, boards, mediums) must always be fetched from their respective DB tables — never hardcoded in frontend or services.
- **Naming**: Models singular PascalCase, tables plural snake_case, controllers `TenantsController`, repositories `TenantRepository`, services `TenantService`, requests `CreateTenantRequest`.
- **Queries**: Always select specific columns, always eager-load relations to avoid N+1, always scope to `tenant_id`.
- **Authorization**: Enforce in the Service layer, not controllers.

## Git Conventions

Branch names: `feature/`, `fix/`, `refactor/`, `hotfix/`

Commit format: `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`
