# Stationary Shop Inventory System — Design Spec

Date: 2026-09-18

## Context

User wants an inventory management/tracking system for a stationary shop,
built on top of the open-source InvenTree project rather than from scratch.
The longer-term vision is a multi-tenant, multi-industry platform (each
tenant a different kind of business), but the immediate goal is to get a
working system for **one tenant: a stationary shop**. The system must
support single-location operation today and multi-location operation
without redesign later. Database will run on Supabase (hosted Postgres)
instead of a local Postgres container, and the app runs locally (Docker)
for now — no VPS deploy yet.

## Goals

- Working InvenTree instance, usable day one for stationary shop stock
  tracking (parts, stock levels, locations, reorder awareness).
- Data lives in Supabase-hosted Postgres, not a local DB container.
- Architecture pattern chosen now must not block adding more tenants
  (other shops, later other industries) without rearchitecting.
- No InvenTree core code forking in v1 — customization deferred until
  real usage reveals actual needs (per user: "not sure yet").
- Fresh start — no existing data to migrate.
- Basic role separation: admin (full access) vs staff (stock
  view/adjust only) from day one, room to grow to larger teams later.

## Non-Goals (v1)

- No true multi-tenant application code (shared DB tenant routing,
  schema-per-tenant Django middleware, etc.) — explicitly rejected in
  favor of simplicity (see Decision below).
- No custom InvenTree plugin or frontend work.
- No purchase orders / supplier / manufacturing workflows unless it
  turns out to be needed — start with Parts + Stock + Locations.
- No data import (nothing existing to bring in).
- No production VPS deployment yet (local Docker only for now).

## Decision: Tenant Isolation Model

Three options were considered for supporting multiple tenants in the
future:

1. **Instance-per-tenant** (chosen) — every tenant gets its own
   InvenTree deployment and its own database. No InvenTree code
   changes. Isolation is structural (separate processes/DBs), not
   logical. Adding a tenant = repeat the same provisioning steps with
   a new Supabase project/DB and a new container set.
2. **Schema-per-tenant, shared app** — one InvenTree deployment routes
   requests to different Postgres schemas based on subdomain/tenant.
   Rejected: InvenTree (Django) has no built-in tenant-routing layer;
   this requires bolting on something like `django-tenants`, patching
   settings/middleware/migrations, and re-doing that work against every
   upstream InvenTree update.
3. **Shared DB, `tenant_id` row filtering** — single DB, every model
   and query filtered by tenant. Rejected: heaviest option, effectively
   a permanent fork of InvenTree's models/views/API, hardest to keep in
   sync with upstream.

**Chosen: Instance-per-tenant.** Zero core forking, isolation is
guaranteed by deployment topology, and it doesn't block "multi-industry
later" — a new industry/tenant just means a new instance with its own
category/field configuration, not new app code.

## Terminology

InvenTree's built-in UI labels (Parts, Stock Items, Locations,
Suppliers, ...) are **not** renamed in v1 — relabeling the UI is a
frontend/plugin customization task, explicitly deferred. Instead,
"stationary shop" identity comes from the **data configured inside**
the generic InvenTree structures:

- Part Categories: e.g. Pens & Writing, Notebooks & Paper, Files &
  Folders, Art Supplies, Office Consumables, Stationery Sets.
- Stock Location tree: root = shop (or shop name), children = shelves
  / racks / bins as needed. Works identically whether the shop has one
  location or several.
- Any project docs/README use stationary-shop language even though the
  underlying InvenTree fields stay generic.

## Architecture

```
Local machine (Docker Compose)
├── inventree-server   (Django app + API + web UI)
├── inventree-worker   (background tasks: reports, notifications)
└── inventree-proxy    (optional, nginx in front of server)
        │
        ▼ (Postgres wire protocol, sslmode=require)
Supabase Project (hosted Postgres)
└── stationary-tenant DB
```

- `docker-compose.yml` based on InvenTree's official compose file, with
  the local `db` (Postgres) service **removed**.
- `docker.env` (or equivalent env file) sets:
  - `INVENTREE_DB_ENGINE=postgresql`
  - `INVENTREE_DB_HOST`, `INVENTREE_DB_PORT`, `INVENTREE_DB_NAME`,
    `INVENTREE_DB_USER`, `INVENTREE_DB_PASSWORD` — from the Supabase
    connection string.
  - `INVENTREE_DB_OPTIONS` set for `sslmode=require` (Supabase requires
    SSL).
- First boot runs InvenTree's standard DB migration step against the
  Supabase DB, then admin user creation (`invoke superuser` or
  equivalent management command).

## Data Model Setup (inside InvenTree, no code)

- One or more Part Categories matching stationary product lines
  (see Terminology above).
- Stock Location tree representing the shop's physical layout
  (single root location is fine for now; can add children any time
  without migration).
- Reorder/minimum stock levels set per Part as needed, using
  InvenTree's native low-stock feature.

## Users & Permissions

Use InvenTree's built-in Groups & Permissions (no custom code):

- **Admin group**: full access (parts, stock, locations, users,
  settings).
- **Staff group**: view stock, perform stock adjustments (stock
  in/out), cannot delete parts/locations or change system config.

This scales to "2-5 people" or "larger team" later by adding more
users to the Staff group, or defining additional groups with
InvenTree's granular permission system — no rearchitecting needed.

## Future Tenant Provisioning (documented, not built in v1)

To add a new tenant (another shop, or a different industry) later:

1. Create a new Supabase project/DB for that tenant.
2. Copy the Docker Compose + env file, point at the new DB connection
   string.
3. Run the same first-boot steps (migrate, create admin).
4. Configure that tenant's own Part Categories / Locations to match
   its industry.

No shared code changes required to onboard a new tenant under this
model.

## Verification Plan

1. `docker compose up` brings up `inventree-server` (and worker) with
   no local DB container.
2. InvenTree web UI reachable at `localhost:<port>`.
3. Confirm InvenTree's tables appear in the Supabase project (visible
   in Supabase's table editor / SQL editor).
4. Create the admin superuser; log in.
5. Create one Part Category, one Part, one Stock Location, add stock
   to that location, perform a stock adjustment — confirm it persists
   (reload page / restart container, data still there — proves it's
   really hitting Supabase, not a local ephemeral DB).
6. Create a Staff-group test user; confirm they can view/adjust stock
   but cannot delete a part or reach system settings.

## Open Items / Deferred Decisions

- Production deployment target (Zunkiree VPS via existing CI/CD skill)
  — deferred, local-only for now per user.
- Any InvenTree customization (branding, workflow, plugins) — deferred
  until real usage surfaces concrete needs.
- Purchase orders / supplier workflows — add only if/when needed.
