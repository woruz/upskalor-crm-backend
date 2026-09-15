# Upskalor CRM Backend

Backend API for the Upskalor CRM platform. The project is organized as a modular monolith so each CRM capability can own its routes, validation, services, persistence, and types.

> **Project status:** The backend currently provides authentication, tenant-aware authorization, lead management, lead search, S3-backed lead import, and S3-backed lead export APIs.

## Requirements

- Node.js `20.20.0` (see `.nvmrc`)
- npm
- Git

Using `nvm`:

```bash
nvm install
nvm use
```

## Getting started

Clone the repository and install its dependencies:

```bash
git clone <repository-url>
cd upskalor-crm-backend
npm install
```

Create a local environment file from the template:

```bash
cp .env.example .env
```

Never commit `.env`. It is ignored by Git and should contain only environment-specific values.

The install step also prepares Husky Git hooks. If hooks are not installed automatically, run:

```bash
npm run prepare
chmod +x .husky/commit-msg .husky/pre-commit
```

## Available commands

```bash
npm run lint          # Check the code with ESLint
npm run lint:fix      # Fix automatically fixable ESLint issues
npm run format:check  # Check formatting with Prettier
npm run format:fix    # Format files with Prettier
npm run build         # Compile TypeScript to dist/
npm start             # Start the compiled server
npm run dev           # Rebuild and restart on source changes
npm run db:generate   # Generate Drizzle migrations
npm run db:migrate    # Apply Drizzle migrations
npm run prepare       # Install Husky Git hooks
```

There are no application defaults. Configure every required value in `.env`: `NODE_ENV`, `HOST`, `PORT`, `REQUEST_BODY_LIMIT`, `DATABASE_URL`, `AWS_REGION`, `S3_BUCKET`, `S3_PRESIGN_EXPIRES_IN`, `MAX_LEAD_IMPORT_FILE_SIZE`, and `MAX_LEAD_EXPORT_ROWS`.

`DATABASE_URL` must be a PostgreSQL connection string, for example `postgresql://postgres:password@localhost:5432/upskalor_crm`.

Lead imports and exports use the AWS SDK default credential chain. Set `AWS_REGION` and `S3_BUCKET`, plus positive integer values for the presigned URL lifetime in seconds, maximum import size in bytes, and maximum export row count. AWS credentials must remain server-side and must not be sent to clients.

The server exposes health, authentication, administration, permissions, and lead routes. All lead routes require authentication and company permission checks.

## Lead APIs

### Lead management and search

```text
POST   /leads
GET    /leads
GET    /leads/:id
PATCH  /leads/:id
DELETE /leads/:id
PATCH  /leads/:id/status
PATCH  /leads/:id/assign
GET    /leads/:id/activities
```

`GET /leads` supports database-level pagination, search, filtering, and sorting:

```text
page, limit
search
status
assignedExecutive
leadSource
state
city
followUpDate
followUpDateFrom
followUpDateTo
sort: createdAt | followUpDate | customerName | status
direction: asc | desc
```

Search covers customer name, mobile number, and email. Deleted leads are excluded from normal queries.

Lead validation includes required customer name, Indian mobile number format, follow-up date, optional email format, non-negative monthly bill amount, lead status, and executive UUID validation. Lead statuses are centralized as `NEW`, `CONTACTED`, `FOLLOW_UP`, `INTERESTED`, `NOT_INTERESTED`, `CONVERTED`, and `LOST`.

### Lead import

Imports support CSV and XLSX files without sending file contents through the API server:

```text
POST /leads/import/upload-url
POST /leads/import
GET  /leads/import/:importId
GET  /leads/import/:importId/error-report
```

The flow is:

1. Request a presigned S3 PUT URL.
2. Upload the CSV/XLSX file directly from the client to S3.
3. Confirm the upload with its `fileId` and tenant-scoped object key.
4. Process the file asynchronously in the lead transfer worker.
5. Poll the import status and download a presigned error report when needed.

Imports validate every row, reuse lead creation validation, detect duplicate mobile numbers, insert valid rows in chunks, and track total, successful, failed, and duplicate rows.

### Lead export

```text
POST /leads/export
GET  /leads/export/:exportId
GET  /leads/export/:exportId/download
```

Exports support `csv` and `xlsx`. Export filters use the same lead query and search logic as `GET /leads`. Results are generated asynchronously, uploaded to S3, and exposed through a short-lived presigned download URL.

Import and export records are tenant-scoped. S3 credentials are never returned to clients, and object keys are checked against the authenticated company and user before access is granted.

## Commit messages

Commits are checked with Commitlint through the Husky `commit-msg` hook. Use Conventional Commit format:

```text
<type>: <subject>
```

Examples:

```bash
git commit -m "feat: add contact management"
git commit -m "fix: validate lead status"
git commit -m "chore: update dependencies"
```

Supported types include `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`, `perf`, `ci`, `build`, and `revert`.

## Project structure

```text
src/
├── common/
│   ├── constants/       HTTP, environment, server, and database constants
│   ├── types/           Shared configuration and HTTP types
│   └── utils/           Shared utilities, including S3 storage helpers
├── config/              Environment and application configuration
├── database/
│   ├── client.ts        PostgreSQL connection pool and Drizzle client
│   ├── schema.ts        Root company, user, role, and permission tables
│   ├── tenants.ts       Tenant schema creation and tenant-owned tables
│   ├── permissions.ts   Available RBAC resources and actions
│   └── migrations/      Drizzle migrations and metadata
├── events/              Reserved for domain events and handlers
├── jobs/                Reserved for shared background jobs
├── middleware/
│   ├── auth.ts          Bearer token extraction and authentication context
│   └── permissions.ts   Company permission checks
├── modules/
│   ├── auth/            Registration, login, permissions, and RBAC
│   └── leads/
│       ├── leads.ts             Lead validation, CRUD, filters, and search
│       ├── leads.test.ts        Lead validation and filter tests
│       ├── lead-transfers.ts    S3 import/export processing
│       └── lead-transfers.test.ts  Transfer validation tests
├── routes/
│   ├── index.ts          Main HTTP route dispatcher
│   ├── auth.ts           Authentication routes
│   ├── admin.ts          Administration routes
│   ├── permissions.ts    Permission administration routes
│   ├── health.ts         Health and readiness routes
│   └── leads.ts          Lead CRUD, search, import, and export routes
└── index.ts              HTTP server composition and lifecycle
```

Business rules stay inside the module that owns them. Move code into `common/` only when it is genuinely shared across domains. Tenant lead, import, export, activity, and error-report tables are created in each company schema and reference users from the root schema.

## Development workflow

1. Create a feature branch.
2. Install dependencies with `npm install`.
3. Make the change in the relevant module.
4. Run `npm run lint` and `npm run format:check`.
5. Commit using the Conventional Commit format.
6. Open a pull request with a clear description and validation notes.

## License

This project is currently private and does not yet declare a public license.
