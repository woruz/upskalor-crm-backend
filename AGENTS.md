# Upskalor CRM Backend — Agent Instructions & Operational Rules

This repository operates under strict architectural conventions. Before writing code or proposing changes, you **must adhere to the constraints defined in this file and [PROJECT_CONTEXT.md](file:///c:/Users/ADMIN/Documents/projects/javascript/upskalor-crm-backend/PROJECT_CONTEXT.md)**.

---

## 1. Golden Rules for this Codebase

1. **Native Node.js HTTP (Zero Express / Fastify)**:
   - This application is built using Node.js's built-in `node:http` module.
   - **DO NOT** import Express, Fastify, or Express-style middleware (`req.body`, `res.status().json()`).
   - All routes are handled through the custom dispatcher in `src/routes/index.ts` and module route files.

2. **ESM Import Syntax**:
   - The project uses pure ECMAScript Modules (`"type": "module"` in `package.json`).
   - **All relative imports MUST include the `.js` extension** (e.g., `import { ... } from './database/redis.js'`).
   - Missing `.js` causes runtime `ERR_MODULE_NOT_FOUND` in Node.js.

3. **TypeScript Strictness**:
   - `tsconfig.json` has `verbatimModuleSyntax: true`.
   - Always use `import type { ... }` when importing types or interfaces.
   - Do not leave unused imports, variables, or function arguments (`noUnusedLocals`, `noUnusedParameters`).

4. **Database Architecture & Multi-Tenancy**:
   - **Root Schema (`root.*`)**: Contains platform-wide tables (`companies`, `users`, `roles`, `refresh_tokens`). Query using **Drizzle typed ORM methods** (`database.select().from(users)...`).
   - **Tenant Schemas (`company_<id>.*`)**: Dynamic per company at runtime. Query using **Drizzle's `sql` template tag** with parameterized inputs (`${value}`).
   - Schema names MUST be quoted using `quotedSchema(schemaName)` (`"${schemaName}"`).
   - **NEVER** use `sql.raw()` for user inputs or parameters.
   - **NEVER** run DDL statements on every request. Tenant table creation is guarded by the Redis flag `CACHE_KEYS.tenantInitialized(companyId)`.

5. **Redis Caching Layer (`src/database/redis.ts`)**:
   - Upstash Redis is connected via `ioredis` with TLS (`rediss://`).
   - Use `CACHE_KEYS` and `CACHE_TTL` from `src/common/constants/cache.constants.ts`.
   - Cached keys:
     - `perm:<companyId>:<role>` (5 min TTL) — Permissions set for fast RBAC (0 DB queries on cache hit).
     - `schema:<companyId>` (1 hour TTL) — Tenant PostgreSQL schema name.
     - `tenant_init:<companyId>` (24 hours TTL) — DDL initialization guard flag.
   - When updating roles or permissions, invalidate the respective Redis cache key immediately.
   - All Redis cache operations are fault-tolerant: failure to reach Redis must never crash HTTP requests.

6. **Avoid N+1 Queries**:
   - Use single-pass Common Table Expressions (CTEs) with `count(*) over() as total_count` for paginated list queries.
   - Use `bulkInsertItems` with `sql.join` for multiple line items instead of looping inserts.

7. **Windows Terminal & Package Management**:
   - When installing packages, always use `npm install <pkg> --legacy-peer-deps`.
   - When validating TypeScript, execute `node ./node_modules/typescript/bin/tsc --noEmit` (PowerShell may block `.ps1` files).

8. **BullMQ Background Processing (`src/jobs/`)**:
   - BullMQ queues and workers require a dedicated Redis connection with `maxRetriesPerRequest: null` via `createBullMqRedisConnection()` from `src/jobs/redis.ts`.
   - File processing (parsing CSV/Excel from S3, bulk lead inserts) is handled asynchronously via the `lead-import` BullMQ queue.
   - Workers are initialized in `startServer()` and gracefully drained/closed in `shutdown()`.

---

## 2. Quick File Reference

- **Full Project Context**: [PROJECT_CONTEXT.md](file:///c:/Users/ADMIN/Documents/projects/javascript/upskalor-crm-backend/PROJECT_CONTEXT.md)
- **Server Entrypoint**: [src/index.ts](file:///c:/Users/ADMIN/Documents/projects/javascript/upskalor-crm-backend/src/index.ts)
- **HTTP Routing Dispatcher**: [src/routes/index.ts](file:///c:/Users/ADMIN/Documents/projects/javascript/upskalor-crm-backend/src/routes/index.ts)
- **Database Client & Root Schema**: [src/database/client.ts](file:///c:/Users/ADMIN/Documents/projects/javascript/upskalor-crm-backend/src/database/client.ts), [src/database/schema.ts](file:///c:/Users/ADMIN/Documents/projects/javascript/upskalor-crm-backend/src/database/schema.ts)
- **Tenant Management & DDL**: [src/database/tenants.ts](file:///c:/Users/ADMIN/Documents/projects/javascript/upskalor-crm-backend/src/database/tenants.ts)
- **Redis Client & Helpers**: [src/database/redis.ts](file:///c:/Users/ADMIN/Documents/projects/javascript/upskalor-crm-backend/src/database/redis.ts)
- **BullMQ Infrastructure**: [src/jobs/index.ts](file:///c:/Users/ADMIN/Documents/projects/javascript/upskalor-crm-backend/src/jobs/index.ts), [src/jobs/redis.ts](file:///c:/Users/ADMIN/Documents/projects/javascript/upskalor-crm-backend/src/jobs/redis.ts), [src/jobs/queues/lead-import.queue.ts](file:///c:/Users/ADMIN/Documents/projects/javascript/upskalor-crm-backend/src/jobs/queues/lead-import.queue.ts), [src/jobs/workers/lead-import.worker.ts](file:///c:/Users/ADMIN/Documents/projects/javascript/upskalor-crm-backend/src/jobs/workers/lead-import.worker.ts)
- **Cache Constants**: [src/common/constants/cache.constants.ts](file:///c:/Users/ADMIN/Documents/projects/javascript/upskalor-crm-backend/src/common/constants/cache.constants.ts)
- **Auth & RBAC**: [src/middleware/auth.ts](file:///c:/Users/ADMIN/Documents/projects/javascript/upskalor-crm-backend/src/middleware/auth.ts), [src/middleware/permissions.ts](file:///c:/Users/ADMIN/Documents/projects/javascript/upskalor-crm-backend/src/middleware/permissions.ts)
- **Leads Domain**: [src/modules/leads/leads.ts](file:///c:/Users/ADMIN/Documents/projects/javascript/upskalor-crm-backend/src/modules/leads/leads.ts), [src/modules/leads/lead-transfers.ts](file:///c:/Users/ADMIN/Documents/projects/javascript/upskalor-crm-backend/src/modules/leads/lead-transfers.ts), [src/routes/leads.ts](file:///c:/Users/ADMIN/Documents/projects/javascript/upskalor-crm-backend/src/routes/leads.ts)
- **Quotations Domain**: [src/modules/quotations/quotations.ts](file:///c:/Users/ADMIN/Documents/projects/javascript/upskalor-crm-backend/src/modules/quotations/quotations.ts), [src/routes/quotations.ts](file:///c:/Users/ADMIN/Documents/projects/javascript/upskalor-crm-backend/src/routes/quotations.ts)
- **Webhooks Dispatcher**: [src/routes/webhooks.ts](file:///c:/Users/ADMIN/Documents/projects/javascript/upskalor-crm-backend/src/routes/webhooks.ts)
- **OpenAPI / Swagger Spec**: [swagger.json](file:///c:/Users/ADMIN/Documents/projects/javascript/upskalor-crm-backend/swagger.json), [openapi.yaml](file:///c:/Users/ADMIN/Documents/projects/javascript/upskalor-crm-backend/openapi.yaml)
