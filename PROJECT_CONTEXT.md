# Upskalor CRM Backend — Master Context & Architectural Guide

> **Notice to AI Models & Agents**:  
> **READ THIS DOCUMENT FIRST BEFORE SCANNING THE REPOSITORY.**  
> This document contains the full architecture, current state of implementation, coding constraints, multi-tenancy rules, caching patterns, and database standards for `upskalor-crm-backend`.

---

## 1. Executive Summary & Tech Stack

**Upskalor CRM Backend** is a high-performance, multi-tenant B2B CRM engine tailored for solar energy contractors and lead-to-installation workflows.

### Core Technologies
- **Runtime**: Node.js `20.20.0` (Locked via `.nvmrc`)
- **Module System**: Pure ECMAScript Modules (**ESM**, `"type": "module"` in `package.json`)
- **Language**: TypeScript `6.x` (`module: "nodenext"`, `target: "esnext"`, `strict: true`, `verbatimModuleSyntax: true`)
- **HTTP Engine**: **Native Node.js `node:http`** (**Zero framework** — No Express, No Fastify, No NestJS). Custom asynchronous routing pipeline in `src/routes/index.ts`.
- **Primary Database**: PostgreSQL (Hosted on **Neon** serverless connection pooler)
- **Database ORM & Query Builder**: **Drizzle ORM** (`drizzle-orm/neon-http` / `drizzle-orm/pg-core`)
- **Caching & In-Memory Store**: **Upstash Redis** via `ioredis` (TLS `rediss://`), singleton client in `src/database/redis.ts`
- **API Documentation**: OpenAPI 3.0 / Swagger UI hosted natively at `/docs` and `/api-docs` serving `swagger.json` and `openapi.yaml`
- **Code Standards**: Prettier (4-space indentation, single quotes, no semicolons, 150 char print width), ESLint 9+ flat config, Commitlint + Husky

---

## 2. Directory Structure & Key Files

```
upskalor-crm-backend/
├── .env                          # Local environment secrets (DATABASE_URL, REDIS_URL, etc.)
├── .env.example                  # Template of required environment variables
├── .nvmrc                        # 20.20.0
├── package.json                  # Dependencies, scripts, lint-staged config
├── tsconfig.json                 # Strict TypeScript configuration (nodenext, verbatimModuleSyntax)
├── swagger.json / openapi.yaml   # Comprehensive OpenAPI 3.0 API specifications
├── src/
│   ├── index.ts                  # Server entrypoint, native createServer(), graceful shutdown
│   ├── common/
│   │   ├── constants/
│   │   │   ├── cache.constants.ts       # Cache keys & TTL definitions
│   │   │   ├── environment.constants.ts # Env variable names
│   │   │   ├── http.constants.ts        # HTTP headers, methods, status codes
│   │   │   └── server.constants.ts      # Timeouts, limits, shutdown delays
│   │   └── types/
│   │       ├── config.ts         # AppConfig interface
│   │       └── http.ts           # Standard response/error types
│   ├── config/
│   │   └── environment.ts        # Environment variable parsing and validation
│   ├── database/
│   │   ├── client.ts             # Drizzle client instance (Neon PostgreSQL connection)
│   │   ├── redis.ts              # ioredis client singleton & fault-tolerant cache helpers
│   │   ├── schema.ts             # Drizzle schema for platform-wide root tables
│   │   └── tenants.ts            # Dynamic tenant schema provisioning & role permissions
│   ├── jobs/
│   │   ├── index.ts                  # BullMQ workers lifecycle & exports
│   │   ├── redis.ts                  # BullMQ dedicated Redis connection factory (maxRetriesPerRequest: null)
│   │   ├── queues/
│   │   │   └── lead-import.queue.ts  # 'lead-import' BullMQ queue & enqueueLeadImportJob
│   │   └── workers/
│   │       └── lead-import.worker.ts # BullMQ worker for parsing S3 CSV/XLSX and bulk inserting
│   ├── middleware/
│   │   ├── auth.ts               # Bearer JWT extraction and role validation
│   │   └── permissions.ts        # Fast Redis-cached RBAC permission-set evaluation
│   ├── modules/
│   │   ├── auth/                 # Authentication, JWT rotation, bcrypt password hashing, RBAC
│   │   ├── leads/                # Leads CRUD, CTE pagination, assignments, CSV import/export
│   │   └── quotations/           # Solar quote generation, PM Surya Ghar subsidy, item bulking
│   └── routes/
│       ├── index.ts              # Master request dispatcher, Swagger UI serving, payload limits
│       ├── admin.ts              # Platform admin routes
│       ├── auth.ts               # /auth/register-company, /auth/login, /auth/refresh-token, /auth/logout
│       ├── health.ts             # /health (database and system liveness)
│       ├── leads.ts              # /leads REST endpoints
│       ├── permissions.ts        # /permissions RBAC endpoints
│       ├── quotations.ts         # /quotations REST endpoints
│       └── webhooks.ts           # /webhooks/s3 and /leads/import/webhook S3 upload hooks
```

---

## 3. Architecture & Multi-Tenancy Design

### 3.1 Schema-Based Isolation Model
The application isolates tenant data at the PostgreSQL schema level:

1. **`root` Schema**: Platform-wide global data:
   - `root.companies` — Registered companies, metadata, and assigned schema name
   - `root.users` — User accounts (with foreign key to `root.companies`)
   - `root.roles` — System and custom roles (`super_admin`, `admin`, `user`)
   - `root.actions` & `root.resources` — System-wide permission primitives
   - `root.refresh_tokens` — Cryptographically hashed refresh token families (reuse detection)

2. **Tenant Schemas (`company_<companyId>`)**: Each tenant company receives an isolated schema:
   - `${qs}.leads` — Customer lead records, status, stage, roof details, executive assignment
   - `${qs}.lead_notes` — Timestamped notes attached to leads
   - `${qs}.lead_activities` — Audit log of all lead state changes, calls, assignments
   - `${qs}.lead_imports` & `${qs}.lead_import_errors` — Bulk CSV import tracking and row errors
   - `${qs}.lead_exports` — Async CSV export job metadata
   - `${qs}.quotations` — Solar PV quotes (pricing, capacity, solar subsidies, terms, status)
   - `${qs}.quotation_items` — Line items (panels, inverters, structures, BOS, installation)
   - `${qs}.role_permissions` — Tenant-specific RBAC permission matrix overrides

### 3.2 Dual Database Query Pattern (CRITICAL RULE)
Because tenant schemas are dynamically created at runtime based on company UUIDs:

- **Root Tables (`root.*`)**:
  - **MUST use Drizzle typed models** imported from `src/database/schema.ts`.
  - Example:
    ```typescript
    const [user] = await database
        .select()
        .from(users)
        .where(and(eq(users.companyId, companyId), eq(users.id, executiveId)))
    ```

- **Tenant Tables (`company_<id>.*`)**:
  - Drizzle **cannot** compile static type schemas for dynamic runtime schema names.
  - **MUST use Drizzle's `sql` template tag** with parameterized arguments.
  - Identifier quoting: Always quote schema identifiers using `quotedSchema(schemaName)` (`"${schemaName}"`).
  - **NEVER use `sql.raw()` for user inputs or parameters** — only use `sql.raw()` for static identifiers like schema/table names. All query values must be passed as parameterized template expressions (`${value}`).
  - Example:
    ```typescript
    const qs = quotedSchema(schemaName)
    const rows = await database.execute(
        sql`select id, customer_name from ${sql.raw(`${qs}.leads`)} where id = ${leadId} and status = ${status}`
    )
    ```

---

## 4. Redis Caching System (`src/database/redis.ts`)

The backend integrates an **Upstash Redis** caching layer via `ioredis` with TLS (`rediss://`).

### 4.1 Cache Keys & Expirations (`src/common/constants/cache.constants.ts`)

| Key Pattern | TTL | Purpose | Invalidation Event |
| :--- | :--- | :--- | :--- |
| `perm:<companyId>:<role>` | 5 minutes (`300s`) | Cached array of `role:resource:action` strings. Fast-path authorization in `requireCompanyPermission` (0 DB queries on cache hit). | Invalidated in `tenants.ts` whenever `upsertRolePermission` or `deleteRolePermission` is called. |
| `schema:<companyId>` | 1 hour (`3600s`) | Cached PostgreSQL schema name for a company. | Set on company registration; read on every tenant request. |
| `tenant_init:<companyId>` | 24 hours (`86400s`) | **DDL Guard Flag**. Prevents redundant `CREATE TABLE IF NOT EXISTS` execution on every API call. | Set when tenant tables are verified/created. |

### 4.2 DDL Initialization Guard
- Previously, `ensureCompanyLeadTables` called DDL on every single HTTP request.
- **Current Pattern**: `ensureCompanyLeadTables` checks `tenant_init:<companyId>` in Redis.
  - If `true` → returns `getCompanySchemaNameById(companyId)` directly (**Zero DDL, fast-path**).
  - If miss → executes `createCompanyLeadTables` + `createCompanyQuotationTables`, sets the Redis flag, and caches the schema name.
- `ensureCompanyQuotationTables` delegates directly to `ensureCompanyLeadTables`.

### 4.3 Fault Tolerance
All Redis helpers (`getCache`, `setCache`, `deleteCache`, `deleteCacheByPattern`) wrap operations in `try/catch` blocks. If Redis is unavailable or disconnected, the cache helper gracefully returns `null`, allowing the backend to fall back to direct PostgreSQL queries without crashing requests.

---

## 5. Security & Authentication Architecture

1. **Password Hashing**: `bcrypt` with work factor 10.
2. **Access Tokens**: Short-lived JWTs (default `15m`) signed with `JWT_SECRET`, carrying `{ id, role, companyId, companySlug, email }`.
3. **Refresh Tokens**: Long-lived tokens (default `7d`). Stored in `root.refresh_tokens` as a SHA-256 hash. Implements **Refresh Token Rotation with Family Tracking**:
   - Each refresh generates a new token belonging to the same `family_id`.
   - If a revoked or superseded token is presented, the entire family is immediately invalidated (mitigates token theft).
4. **RBAC Middleware**:
   - `authorizeRequest(req, secret, allowedRoles)`: Validates JWT Bearer scheme and checks user role.
   - `requireCompanyPermission(req, secret, { resourceName, actionName }, allowedRoles)`: Evaluates permissions against the tenant's cached permission set in Redis.

---

## 6. Modules & Features Completed

### 6.1 Authentication (`src/modules/auth/`, `src/routes/auth.ts`)
- `POST /auth/register-company`: Registers company, generates schema, provisions super-admin, seeds default permissions, and pre-warms Redis cache.
- `POST /auth/login`: Authenticates email + password, issues JWT access token + refresh token cookie/body.
- `POST /auth/refresh-token`: Rotates refresh token within family.
- `POST /auth/logout`: Revokes current refresh token family.

### 6.2 Leads Management & Asynchronous S3 Imports (`src/modules/leads/`, `src/routes/leads.ts`, `src/jobs/`)
- **Single CTE Window Query**: `listLeads` uses `count(*) over() as total_count` inside a Common Table Expression to return paginated data and total count in **a single database round-trip** (no N+1 count query).
- **Lead Executive Assignment**: `verifyExecutive` verifies assignee existence in `root.users` via Drizzle typed query.
- **Parameterized Updates**: `updateLead` maps fields to safe parameterized `sql` expressions (no `sql.raw(col)`).
- **Activity & Note Logging**: Automatic insertion into `${qs}.lead_activities` on creation, status change, reassignment.
- **Asynchronous File Imports (BullMQ + S3)**:
  - `POST /leads/import/upload-url`: Generates presigned S3 PUT URL for direct client upload.
  - `POST /leads/import`: Client confirmation hook after upload; marks status as `QUEUED` and enqueues to BullMQ `lead-import` queue.
  - `POST /webhooks/s3` and `POST /leads/import/webhook`: Direct S3 Event Notification hook listening for newly uploaded objects (`s3:ObjectCreated:*`), parses object key (`leads/{companyId}/imports/{userId}/{fileId}.{ext}`), and enqueues to BullMQ.
  - **BullMQ Background Worker (`src/jobs/workers/lead-import.worker.ts`)**:
    - Streams file directly from S3 (`getObjectStream`).
    - Parses `.csv` (via `csv-parse`) or `.xlsx` (via `exceljs` stream reader).
    - Cleans Excel cell values (rich text, formulas, dates).
    - Validates row inputs and detects duplicate phone numbers (within file and against database).
    - Inserts valid leads in chunks into `${qs}.leads`.
    - Writes error CSV report back to S3 if any invalid rows are found and logs to `${qs}.lead_import_errors`.
    - Updates `${qs}.lead_imports` record with final counts and status (`COMPLETED` or `COMPLETED_WITH_ERRORS`).
- **CSV/XLSX Export**: Asynchronous export job tracking in `${qs}.lead_exports`.

### 6.3 Quotations Management (`src/modules/quotations/`, `src/routes/quotations.ts`)
- **Solar Quote Engine**: Calculates subtotal, GST (e.g. 13.8%), central solar subsidy (PM Surya Ghar / MNRE slab rates), state subsidy caps, and net customer cost.
- **Bulk Item Insert**: `bulkInsertItems` executes a single multi-row `INSERT INTO ... VALUES (...), (...)` via `sql.join` (eliminates N sequential inserts).
- **Quote Versioning**: `POST /quotations/:id/version` duplicates an existing quote under a new version tag (`Q-XXXX-V2`), copying all line items.
- **Status Workflow**: `DRAFT` → `SENT` → `ACCEPTED` / `REJECTED` / `EXPIRED`.
- **Soft Deletion**: Quotations track `deleted_at` timestamp.

---

## 7. Development Rules & Strict Constraints

When making changes or adding features to this codebase, **YOU MUST ADHERE TO THE FOLLOWING RULES**:

### Rule 1: Pure Node.js HTTP (No Express Idioms)
Do **NOT** introduce Express, Fastify, or Express middleware:
- Request objects are `node:http.IncomingMessage`.
- Response objects are `node:http.ServerResponse`.
- Always set `Content-Type`, `Content-Length`, `x-request-id`, and security headers.
- Route handlers return a `Promise<boolean>` indicating whether the route was handled.

### Rule 2: Explicit `.js` Import Extensions
Because this is pure Node.js ESM (`"module": "nodenext"`):
- **Every relative import MUST end with `.js`** (e.g., `import { ... } from './database/redis.js'`).
- Omitting `.js` will break Node.js module resolution at runtime.

### Rule 3: Strict TypeScript & Type-Only Imports
- `tsconfig.json` has `verbatimModuleSyntax: true`.
- You MUST import types using `import type { ... } from '...'`.
- Unused variables or parameters will cause compilation errors (`noUnusedLocals`, `noUnusedParameters`).

### Rule 4: Querying Root vs. Tenant Tables
- **Root tables (`root.*`)**: Always use typed Drizzle queries (`database.select().from(...)`).
- **Tenant tables (`"${schemaName}".*`)**: Always use `sql` tagged template literals with `quotedSchema(schemaName)`. Never pass untrusted user inputs to `sql.raw()`.

### Rule 5: Prevent N+1 Queries
- **Never** execute database queries inside `.map()` or `for` loops.
- Use `sql.join()` for batch inserts or bulk operations.
- Use CTEs with window functions (`count(*) over()`) for paginated lists instead of issuing a separate `COUNT(*)` query.

### Rule 6: Cache-First Pattern & Invalidation
- When reading permission sets or company schemas, check Redis first.
- When mutating permissions or company metadata, immediately invalidate the respective Redis cache key.
- Never let Redis failure crash an HTTP request: catch errors and gracefully fall back to PostgreSQL.

### Rule 7: Windows CLI & Package Management
- **Running TypeScript Check**: In PowerShell, `.ps1` script execution may be blocked. Run `node ./node_modules/typescript/bin/tsc --noEmit` instead of `npx tsc`.
- **NPM Installs**: Always use `npm install <pkg> --legacy-peer-deps` to prevent peer dependency conflicts with TypeScript 6.

---

## 8. Environment Variables Reference

| Variable | Required | Description | Example |
| :--- | :---: | :--- | :--- |
| `NODE_ENV` | Optional | `development` / `production` / `test` | `development` |
| `PORT` | Optional | HTTP port (default `4000`) | `4000` |
| `HOST` | Optional | Bind host (default `0.0.0.0`) | `0.0.0.0` |
| `DATABASE_URL` | **Yes** | Neon PostgreSQL connection string | `postgresql://user:pass@ep-...neon.tech/neondb?sslmode=require` |
| `REDIS_URL` | Optional | Upstash Redis connection string (TLS) | `rediss://default:pass@...upstash.io:6379` |
| `JWT_SECRET` | **Yes** | Secret key for signing JWT access tokens | String (min 32 chars) |
| `ACCESS_TOKEN_EXPIRES_IN` | **Yes** | Access token lifespan | `15m` |
| `REFRESH_TOKEN_EXPIRES_IN` | **Yes** | Refresh token lifespan | `7d` |
| `CORS_ORIGIN` | Optional | Allowed CORS origins | `*` or `http://localhost:3000` |
| `LOG_LEVEL` | Optional | Log verbosity (`debug`, `info`, `warn`, `error`) | `info` |
