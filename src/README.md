# Source structure

The backend is organized as a modular monolith. Each business area lives under `modules/` and owns its routes, validation, service logic, persistence, and public types.

- `index.ts`: application composition root and process entry point
- `config/`: environment parsing and application configuration
- `database/`: database client, migrations, seeders, and transaction helpers
- `common/`: shared constants, errors, types, utilities, and validators
- `middleware/`: authentication, authorization, validation, logging, and error handling
- `routes/`: API versioning and route registration
- `modules/`: CRM business capabilities
- `jobs/`: background jobs and scheduled work
- `events/`: domain event contracts and handlers

Keep business rules inside the owning module. Shared code should be promoted to `common/` only when it is genuinely cross-domain.

