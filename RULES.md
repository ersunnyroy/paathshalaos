# PaathshalaOS - Development Rules & Guidelines

---

## 1. PROJECT STRUCTURE

```
paathshala-os/
├── api/                          # Laravel Backend
│   ├── app/
│   │   ├── Console/
│   │   ├── Http/
│   │   │   ├── Controllers/     # API Controllers (thin)
│   │   │   ├── Middleware/      # Tenant, Auth middleware
│   │   │   ├── Requests/        # Form Request validation
│   │   │   └── Resources/       # API Resource/Transformers
│   │   ├── Models/              # Eloquent Models (data only)
│   │   ├── Repositories/        # Repository Pattern
│   │   │   ├── Contracts/        # Interfaces
│   │   │   └── Eloquent/        # Implementations
│   │   ├── Services/             # Business Logic (fat)
│   │   ├── Traits/              # Reusable traits
│   │   └── Helpers/             # Utility functions
│   ├── database/
│   │   ├── migrations/
│   │   ├── seeders/
│   │   └── factories/
│   └── routes/
│       └── api.php
│
└── frontend/                     # React Frontend (Next.js)
    ├── app/
    │   ├── (auth)/              # Auth pages
    │   ├── (main)/              # Protected pages
    │   └── api/                 # API client
    ├── components/               # Reusable components
    ├── hooks/                   # Custom hooks
    ├── services/                # API services
    ├── types/                   # TypeScript types
    └── data/                    # Static reference data
```

---

## 2. DATABASE RULES

### Multi-Tenancy
- Every table MUST have `tenant_id` column (except global tables)
- Use soft deletes (`status` field) - NEVER hard delete
- Schema: `tenants` → `branches` → `users`

### Required Tables
```php
// Core Tables
- tenants (institution/school)
- tenant_domains (subdomain + custom domain mapping)
- branches
- users

// RBAC
- roles
- permissions
- user_roles
- role_permissions

// Modules & Features
- modules
- features
- tenant_modules
- tenant_features

// Reference Data (from DB, NOT static)
- countries
- states
- institute_types
- boards
- mediums
```

---

## 3. REPOSITORY PATTERN

### Layer Order
```
Controller → Service → Repository → Model
```

### Structure
```php
// 1. Model - Data entity only
class Tenant extends Model { }

// 2. Contract - Interface
interface TenantRepositoryInterface {
    public function getAll(array $filters = []);
    public function findById(int $id): ?Tenant;
    public function create(array $data): Tenant;
    public function update(int $id, array $data): Tenant;
    public function delete(int $id): bool;
}

// 3. Repository - Data access
class TenantRepository implements TenantRepositoryInterface {
    protected Tenant $model;
    // CRUD methods only
}

// 4. Service - Business logic
class TenantService {
    public function __construct(private TenantRepositoryInterface $repo) {}
    // Business logic only
}

// 5. Controller - HTTP handling only
class TenantController extends Controller {
    public function index(Request $request) {
        return $this->service->getAll($request->validated());
    }
}
```

---

## 4. SOLID PRINCIPLES

| Letter | Principle | Application |
|--------|----------|------------|
| **S** | Single Responsibility | One class = one job |
| **O** | Open/Closed | Extend via new methods, don't modify |
| **L** | Liskov Substitution | Repo can swap implementations |
| **I** | Interface Segregation | Small focused interfaces |
| **D** | Dependency Inversion | Controller → Service → Repository |

---

## 5. KISS PRINCIPLE

```php
// BAD - Over-engineered
class SuperAdminTeacherStudentUserManager {
    public function createUserWithRolesAndPermissionsAndNotify() {}
}

// GOOD - Simple, focused
class UserService { public function create(UserDTO $dto): User {} }
class RoleService { public function assign(int $userId, int $roleId): void {} }
class NotificationService { public function sendWelcome(User $user): void {} }
```

---

## 6. NAMING CONVENTIONS

| Type | Convention | Example |
|------|------------|---------|
| Model | Singular, PascalCase | `Tenant`, `UserRole` |
| Table | Plural, snake_case | `tenants`, `user_roles` |
| Controller | Plural + Controller | `TenantsController` |
| Repository | Model + Repository | `TenantRepository` |
| Service | Model + Service | `TenantService` |
| Request | Action + Request | `CreateTenantRequest` |
| Method | camelCase, verb+noun | `getAll()`, `findById()` |

---

## 7. API DEVELOPMENT

### Always Use API Resources
```php
// BAD
return response()->json(['data' => $model]);

// GOOD
return (new TenantResource($tenant))->resolve();
```

### Optimized Queries
```php
// BAD
$users = User::all();

// GOOD
$users = User::select('id', 'name', 'email')->where('tenant_id', $tenantId)->get();
```

### Avoid N+1 Queries
```php
// BAD
foreach ($users as $user) { $user->role->name; }

// GOOD
$users = User::with('role')->where('tenant_id', $tenantId)->get();
```

---

## 8. TENANT ISOLATION

### Domain Detection
- Check `tenant_domains` table for custom domain
- Fallback to subdomain extraction
- Store `X-Tenant-ID` in header

### Middleware Flow
```
Request → TenantDetection → AuthMiddleware → Controller
```

---

## 9. CACHING STRATEGY (REDIS)

### Cache Keys
```
tenant:{id}:features      # JSON - enabled features
tenant:{id}:modules       # JSON - enabled modules
user:{id}:permissions   # Array - user permissions
```

### Cache Invalidation
```php
// On feature toggle
Redis::del("tenant:{$tenantId}:features");

// On permission change
Redis::del("user:{$userId}:permissions");
```

---

## 10. REFERENCE DATA

All static dropdown/data MUST come from database:
- Countries, States → `countries`, `states` tables
- Institute Types → `institute_types` table
- Boards, Mediums → Reference tables

**NEVER hardcode in frontend or service layer.**

---

## 11. CUSTOM DOMAINS

### Flow
1. Tenant requests custom domain via API
2. System generates DNS instructions
3. Super admin notified via email
4. After verification, domain activated

### Tables
- `custom_domains`: tenant_id, domain, status (pending/approved/rejected)

---

## 12. NOTIFICATION CONFIGURATION

Each tenant manages:
- **Email (SMTP)**: host, port, username, password, encryption
- **SMS (Twilio)**: SID, auth token, phone number
- **Push (FCM)**: server key, config

### Table
- `notification_settings`: per-tenant notification config

---

## 13. FILE STORAGE

### Drivers
- `local` - Local filesystem
- `minio` - MinIO for local dev
- `s3` - AWS S3 for production

### Path Patterns
Use dynamic placeholders:
```php
'{tenant_id}/logos/logo'           // Tenant logo
'{tenant_id}/branches/{branch_id}/logo'  // Branch logo
'{tenant_id}/users/{user_id}/avatar'     // User avatar
```

### Validation
- Check file extension
- Check file size
- Use FilePathConfig for all uploads

---

## 14. FRONTEND RULES

### Route Structure
```
/login              # Login page
/register           # Institute registration
/dashboard          # Main dashboard
/branches           # Branch management
/roles              # RBAC
/features           # Module/feature toggles
/templates/*         # UIKit reference pages
```

### Theme System
- Two themes: `lara-light-teal`, `lara-dark-teal`
- Detect from browser/OS preference
- User toggle with localStorage preference
- Use PrimeReact components

### API Client
```typescript
// Always use typed responses
interface ApiResponse<T> {
    success: boolean;
    message?: string;
    data?: T;
    errors?: Record<string, string[]>;
}
```

---

## 15. SECURITY

- Server-side validation ONLY
- Authorization in Service layer
- Rate limiting on auth endpoints
- SQL injection: use Eloquent bindings only
- CSRF: Laravel handles via Sanctum

---

## 16. GIT WORKFLOW

### Branch Naming
```
feature/branch-management
fix/auth-logout-issue
refactor/user-repository
hotfix/security-patch
```

### Commit Messages
```
feat: add branch CRUD operations
fix: resolve login redirect issue
refactor: simplify tenant isolation logic
docs: update API documentation
chore: add Redis caching for features
```

---

## ENFORCEMENT

These rules are **MANDATORY**. Before writing any code:

- [ ] Follow Repository Pattern?
- [ ] Single Responsibility?
- [ ] Named correctly?
- [ ] Has tenant_id scope?
- [ ] Soft deletes instead of hard?
- [ ] Has validation?
- [ ] Reference data from DB, not hardcoded?

---

*Last Updated: Phase 1 Complete*
*Maintained by: Development Team*