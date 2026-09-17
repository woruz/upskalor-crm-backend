# Upskalor CRM Backend

Backend API for the Upskalor CRM platform. The project is organized as a modular monolith so each CRM capability can own its routes, validation, services, persistence, and types.

> **Project status:** The repository is currently in the initial scaffolding phase. The module and infrastructure directories are in place, but the application entrypoint and API implementation are still being built.
>
> For a detailed technical walkthrough of what has been done and how it is configured, see [PROJECT_OVERVIEW.md](./PROJECT_OVERVIEW.md).

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
npm run prepare       # Install Husky Git hooks
```

By default, the server listens on `0.0.0.0:3000`. Configure it with `HOST`, `PORT`, `NODE_ENV`, and `REQUEST_BODY_LIMIT` environment variables.

The initial server exposes `GET /health/live` for process health and `GET /health/ready` for readiness checks. Business routes will be added under `src/routes/` as the CRM modules are implemented.

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
├── common/       Shared constants, errors, types, utilities, and validators
├── config/       Application and environment configuration
├── database/     Database client, migrations, seeders, and transaction helpers
├── events/       Domain event contracts and handlers
├── jobs/         Background jobs and scheduled work
├── middleware/   Authentication, authorization, validation, logging, and errors
├── modules/      CRM business capabilities
├── routes/       API versioning and route registration
└── index.ts      Application composition root
```

Business rules should stay inside the module that owns them. Move code into `common/` only when it is genuinely shared across domains.

## Development workflow

1. Create a feature branch.
2. Install dependencies with `npm install`.
3. Make the change in the relevant module.
4. Run `npm run lint` and `npm run format:check`.
5. Commit using the Conventional Commit format.
6. Open a pull request with a clear description and validation notes.

## License

This project is currently private and does not yet declare a public license.

