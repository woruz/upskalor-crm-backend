# Upskalor CRM Backend — Project Overview & Architecture Guide

This document provides a comprehensive technical overview of **what has been completed** so far in the `upskalor-crm-backend` codebase and **how each component is designed, configured, and executed**.

---

## 1. Executive Summary

The **Upskalor CRM Backend** is structured as a **Modular Monolith** built on **Node.js (v20.20.0)** and **TypeScript (v6.0.2 / ESNext)**. 

The repository is currently in its **foundational infrastructure and scaffolding phase**. The core tooling, strict type-checking configuration, linting and code formatting rules, Git hooks, commit conventions, live-reloading dev workflow, and domain-driven folder hierarchy have all been established.

---

## 2. What Has Been Done

A breakdown of all milestones and architectural scaffolding implemented in the project to date:

### A. Environment & Module System Standardization
- **Node.js Target**: Fixed to Node.js `20.20.0` using `.nvmrc` for consistent execution across environments.
- **Native ECMAScript Modules (ESM)**: Configured `"type": "module"` in `package.json`, allowing top-level `import`/`export` syntax and modern module loading throughout the codebase and configuration files.

### B. TypeScript Compilation Pipeline
- **Strict Type Checking**: Configured `tsconfig.json` targeting `esnext` with `nodenext` module resolution.
- **Build Output**: Output destination mapped to `dist/` with source maps (`sourceMap: true`) and declaration files (`declaration: true`).
- **Safety Flags**: Enabled strict null checks, strict function types, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and `verbatimModuleSyntax`.

### C. Code Quality & Formatting Enforcement
- **Modern ESLint 9+ Flat Config**: Configured `eslint.config.mjs` using `@eslint/js`, `typescript-eslint`, and `eslint-config-prettier`.
- **Prettier Code Styling**: Configured `.prettierrc` with single quotes, no semicolons, 4-space indentation, 150-character print width, and CRLF line endings.
- **Automated Staged Checks**: Configured `lint-staged` in `package.json` to automatically format and lint all staged TypeScript (`*.ts`) files during Git commits.

### D. Git Hooks & Commit Standardization
- **Husky Automation**: Configured `.husky/` to hook into Git lifecycle events.
- **Pre-commit Hook (`.husky/pre-commit`)**: Automatically triggers `npx lint-staged` before commits are finalized, preventing malformed or unlinted code from entering Git history.
- **Commit-msg Hook (`.husky/commit-msg`)**: Automatically validates commit messages using `@commitlint/cli` and `@commitlint/config-conventional`.
- **Commitlint Config (`commitlint.config.js`)**: Enforces the Conventional Commits specification (`<type>: <subject>`), custom kebab-case scopes, and recognized commit types (`feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`, `perf`, `ci`, `build`, `revert`).

### E. Modular Monolith Architecture & Scaffolding
- **Domain Modules Partitioning (`src/modules/`)**: Scaffolded 13 core business domains with `.gitkeep` placeholders:
  - `activities` — Activity tracking (calls, meetings, emails)
  - `auth` — Authentication, token issuance, and password security
  - `contacts` — Individual customer/lead contact management
  - `files` — Document and asset uploads/management
  - `leads` — Sales lead intake, qualification, and assignment
  - `notes` — Notes attached to leads, contacts, and deals
  - `notifications` — Internal user alerts and push/email notifications
  - `opportunities` — Deal pipeline and revenue tracking
  - `organizations` — B2B company accounts and organizations
  - `reports` — Analytics, reporting, and pipeline metrics
  - `search` — Cross-entity global search
  - `tasks` — Follow-up tasks, due dates, and assignments
  - `users` — Team members, roles, and administrative accounts
- **Cross-Cutting Layers**:
  - `src/common/`: Shared constants, custom error classes, global TypeScript types, utility functions, and request validators.
  - `src/config/`: Centralized environment variable loading and validation.
  - `src/database/`: Database client connections, migrations, and seeders.
  - `src/events/`: Domain event dispatchers and event handlers.
  - `src/jobs/`: Background workers and scheduled cron tasks.
  - `src/middleware/`: Global middleware (authentication guards, RBAC, error handlers, request loggers).
  - `src/routes/`: Central route registry and API versioning orchestrator.
  - `src/index.ts`: Application composition root and HTTP server entrypoint.

### F. Developer Experience & Workflow Tooling
- **Live Reloading (`nodemon.json`)**: Configured Nodemon to monitor changes in `src/` (`ts, js, json`) and run `npm run build && node dist/index.js`.
- **NPM Scripts**: Integrated scripts for building, running, development, linting, formatting, and Husky setup.
- **Documentation**: Comprehensive root-level `README.md` and `src/README.md` detailing setup, module boundaries, commit rules, and architectural philosophy.

---

## 3. How It Is Done (Technical Deep Dive)

Here is a technical explanation of how each subsystem and configuration works under the hood:

### 3.1 Module System & TypeScript Configuration

The project operates as a pure **ECMAScript Module (ESM)** system.

#### `package.json`
```json
"type": "module",
"main": "index.js",
"scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "nodemon",
    "lint": "eslint .",
    "lint:fix": "eslint . --fix",
    "format:check": "prettier . --check",
    "format:fix": "prettier . --write",
    "prepare": "husky install"
}
```
- `"type": "module"` instructs Node.js to treat all `.js` and `.ts` files as ES modules by default.

#### `tsconfig.json`
Key settings include:
- `"rootDir": "./src"` and `"outDir": "./dist"`: Establishes clear separation between TypeScript source code and compiled JavaScript artifacts.
- `"module": "nodenext"` and `"target": "esnext"`: Matches Node.js's native ESM resolution algorithm, requiring explicit file extensions (e.g. `.js` in relative imports when compiled) and full modern JavaScript feature support.
- `"strict": true`: Activates standard strict flags (`noImplicitAny`, `strictNullChecks`, `strictFunctionTypes`, etc.).
- `"noUncheckedIndexedAccess": true`: Adds `undefined` to index signatures (e.g., `record[key]` returns `T | undefined`), preventing unhandled runtime lookup crashes.
- `"exactOptionalPropertyTypes": true`: Distinguishes between omitting a property and setting it explicitly to `undefined`.
- `"verbatimModuleSyntax": true`: Requires explicit type imports (`import type { ... } from ...`), preventing inadvertent emission of runtime imports for types.

---

### 3.2 Code Quality & Static Analysis Pipeline

The codebase enforces strict code quality at both development and commit time:

#### `eslint.config.mjs`
Uses the ESLint 9+ Flat Config format:
- Extends `@eslint/js` recommended and `typescript-eslint` recommended configs.
- Integrates `eslint-config-prettier` to eliminate conflicts between ESLint rules and Prettier formatting.
- Configures type-aware linting via `parserOptions: { project: './tsconfig.json' }`.
- **Critical Safety Rules**:
  - `@typescript-eslint/no-floating-promises`: Flags any unhandled Promises to prevent silent async errors.
  - `@typescript-eslint/no-misused-promises`: Catches async functions passed where void callbacks are expected.
  - `@typescript-eslint/await-thenable`: Ensures only Promises are awaited.
  - `@typescript-eslint/consistent-type-imports`: Enforces `import type` for type-only imports.
  - `no-console`: Prevents accidental raw `console.log` calls in favor of structured logging.
  - `eqeqeq` & `curly`: Enforces strict equality (`===`) and mandatory braces on all blocks.

#### `.prettierrc`
```json
{
    "trailingComma": "none",
    "tabWidth": 4,
    "semi": false,
    "singleQuote": true,
    "bracketSameLine": true,
    "printWidth": 150,
    "singleAttributePerLine": true,
    "endOfLine": "crlf"
}
```
Maintains consistent visual style across the team.

---

### 3.3 Git Automation (Husky, Lint-Staged & Commitlint)

Quality enforcement is fully automated via Git hooks:

```text
git commit -m "feat(auth): implement user registration"
      │
      ▼
1. Pre-commit Hook (.husky/pre-commit)
   └─► Runs `npx lint-staged`
         ├─► Matches all staged `*.ts` files
         ├─► Executes `npm run lint:fix`
         └─► Executes `npm run format:fix`
      │ (Fails and blocks commit if unfixable lint errors exist)
      ▼
2. Commit-msg Hook (.husky/commit-msg)
   └─► Runs `npx --no-install commitlint --edit "$1"`
         └─► Validates message format against `commitlint.config.js`
             - Format: `<type>(<scope>): <subject>`
             - Scope must be kebab-case
             - Type must be one of the permitted types
      │ (Fails and blocks commit if message convention is violated)
      ▼
Commit successfully created
```

#### `commitlint.config.js`
```javascript
export default {
    extends: ['@commitlint/config-conventional'],
    rules: {
        'type-enum': [
            2,
            'always',
            ['feat', 'fix', 'docs', 'style', 'refactor', 'test', 'chore', 'perf', 'ci', 'build', 'revert']
        ],
        'subject-case': [2, 'always', 'lower-case'],
        'subject-empty': [2, 'never'],
        'subject-full-stop': [2, 'never', '.'],
        'type-case': [2, 'always', 'lower-case'],
        'type-empty': [2, 'never'],
        'scope-case': [2, 'always', 'kebab-case']
    }
}
```

---

### 3.4 Development Server & Watch Mechanism

#### `nodemon.json`
```json
{
    "watch": ["src"],
    "ext": "ts,js,json",
    "ignore": ["node_modules", "src/**/*.spec.ts", "coverage", "dist"],
    "exec": "npm run build && node dist/index.js",
    "env": {
        "NODE_ENV": "dev"
    },
    "restartable": "rs"
}
```
- Watches for edits inside `src/`.
- On change, executes `npm run build` (TypeScript compiler) and launches `node dist/index.js`.
- Sets `NODE_ENV=dev` and permits manual restarts by typing `rs`.

---

### 3.5 Architectural Design: The Modular Monolith

The backend is organized as a **modular monolith**, striking a balance between microservice-like domain boundaries and single-codebase deployment simplicity:

```text
src/
├── common/             # Truly cross-cutting utilities (errors, validators, types)
│   ├── constants/
│   ├── errors/
│   ├── types/
│   ├── utils/
│   └── validators/
├── config/             # Environment parsing, config validation
├── database/           # Connection pooling, migrations, seed scripts
│   ├── migrations/
│   └── seeders/
├── events/             # Cross-module domain event definitions & dispatchers
├── jobs/               # Asynchronous queue workers & scheduled cron tasks
├── middleware/         # Auth guards, logging, error handling, rate limiting
├── modules/            # Isolated business domain capabilities
│   ├── activities/     # Call / meeting / task logging
│   ├── auth/           # Login, JWT, refresh tokens, password hashing
│   ├── contacts/       # Customer contact details & history
│   ├── files/          # Attachment uploads, S3/storage integration
│   ├── leads/          # Sales leads & qualification pipeline
│   ├── notes/          # Polymorphic note taking on CRM records
│   ├── notifications/  # Notification dispatch & preferences
│   ├── opportunities/  # Deals, stages, win/loss tracking
│   ├── organizations/  # Companies / accounts
│   ├── reports/        # Analytics, aggregates, dashboard stats
│   ├── search/         # Global search indexing & queries
│   ├── tasks/          # Action items, reminders, assignments
│   └── users/          # Internal user management & permissions
├── routes/             # Versioned route registry (e.g. /api/v1)
└── index.ts            # Composition root: boots HTTP server and DB connections
```

#### Key Architecture Rules:
1. **Module Autonomy**: Each module under `src/modules/<name>/` should encapsulate its own:
   - `routes.ts`: Module-specific route declarations.
   - `controller.ts`: HTTP request parsing and response formatting.
   - `service.ts`: Business logic and orchestration.
   - `repository.ts` / `model.ts`: Data access and persistence queries.
   - `validators.ts`: Input validation schemas.
   - `types.ts`: Domain-specific TypeScript types and interfaces.
2. **Strict Encapsulation**: Modules should not directly reach into another module's internal database models. Inter-module communication should happen via exported public services or asynchronous domain events (`src/events/`).
3. **Common Folder Discipline**: Code is placed in `src/common/` only when it is domain-agnostic (e.g., standard HTTP error classes, response formatting helpers, general string utilities).

---

## 4. Current File Tree

```text
upskalor-crm-backend/
├── .husky/
│   ├── _/
│   ├── commit-msg          # Validates commit message via commitlint
│   └── pre-commit          # Runs lint-staged on pre-commit
├── src/
│   ├── common/
│   │   ├── constants/      # Shared application constants (.gitkeep)
│   │   ├── errors/         # Application error classes (.gitkeep)
│   │   ├── types/          # Shared type definitions (.gitkeep)
│   │   ├── utils/          # Generic helper utilities (.gitkeep)
│   │   └── validators/     # Common validation logic (.gitkeep)
│   ├── config/             # Config loader & environment variables (.gitkeep)
│   ├── database/
│   │   ├── migrations/     # Database migration scripts (.gitkeep)
│   │   └── seeders/        # Test/demo seed data (.gitkeep)
│   ├── events/             # Event bus and listeners (.gitkeep)
│   ├── jobs/               # Background job queues & cron (.gitkeep)
│   ├── middleware/         # Express/Fastify middleware (.gitkeep)
│   ├── modules/            # 13 CRM business domain modules (.gitkeep each)
│   │   ├── activities/
│   │   ├── auth/
│   │   ├── contacts/
│   │   ├── files/
│   │   ├── leads/
│   │   ├── notes/
│   │   ├── notifications/
│   │   ├── opportunities/
│   │   ├── organizations/
│   │   ├── reports/
│   │   ├── search/
│   │   ├── tasks/
│   │   └── users/
│   ├── routes/             # Route aggregator (.gitkeep)
│   ├── index.ts            # Server entry point (ready for bootstrapping)
│   └── README.md           # Architecture guidelines for src/
├── .gitignore              # Git ignore rules (node_modules, dist, etc.)
├── .nvmrc                  # Node.js version declaration (20.20.0)
├── .prettierrc             # Prettier code formatting rules
├── commitlint.config.js    # Conventional Commit rules & validation
├── eslint.config.mjs       # ESLint 9 flat configuration with TypeScript rules
├── nodemon.json            # Nodemon reload and build configuration
├── package.json            # Dependencies, scripts, and package metadata
├── package-lock.json       # Dependency lockfile
├── PROJECT_OVERVIEW.md     # This comprehensive documentation file
├── README.md               # Main project README
└── tsconfig.json           # Strict TypeScript compiler options
```

---

## 5. Developer Quick Reference

### Command Matrix

| Command | Action |
| :--- | :--- |
| `npm run dev` | Starts Nodemon, watches `src/`, compiles via `tsc`, and runs `node dist/index.js` |
| `npm run build` | Compiles TypeScript source to `./dist` using `tsc` |
| `npm start` | Runs the compiled JavaScript server from `dist/index.js` |
| `npm run lint` | Inspects code for ESLint violations |
| `npm run lint:fix` | Automatically fixes autofixable ESLint violations |
| `npm run format:check` | Checks formatting with Prettier |
| `npm run format:fix` | Automatically formats all files with Prettier |
| `npm run prepare` | Reinstalls Husky Git hooks in the local repository |

### Commit Convention
Commits must follow the Conventional Commits format:
```text
<type>(<scope>): <subject>
```
- **Allowed Types**: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`, `perf`, `ci`, `build`, `revert`.
- **Scope**: Lowercase kebab-case (e.g. `auth`, `lead-mgmt`, `db-migrations`).
- **Subject**: Lowercase, no trailing period.
- **Example**: `git commit -m "feat(auth): add jwt token generation helper"`

---

## 6. Next Steps & Roadmap

With the foundational scaffolding complete, the immediate development milestones are:

1. **HTTP Framework Selection & Setup (`src/index.ts`)**:
   - Install and configure an HTTP framework (e.g., Express.js or Fastify).
   - Implement process health probes: `GET /health/live` and `GET /health/ready`.
   - Setup graceful shutdown handlers (`SIGTERM`, `SIGINT`).
2. **Configuration Service (`src/config/`)**:
   - Create schema-validated environment configuration (using `dotenv` and `zod` or `joi`).
3. **Database Client & Migrations (`src/database/`)**:
   - Integrate the chosen ORM/query builder (e.g., Prisma, Drizzle, or PostgreSQL client).
   - Define database connection pooling and base migration structure.
4. **Authentication & User Module (`src/modules/auth` & `src/modules/users`)**:
   - Implement user data models, password hashing (`argon2` or `bcrypt`), and JWT issuance.
   - Implement authentication middleware in `src/middleware/`.
5. **Business Modules Implementation**:
   - Implement leads, contacts, organizations, and opportunities endpoints.
