# Inventory Stationary — InvenTree Deployment

Inventory tracking for a stationary shop, built on
[InvenTree](https://github.com/inventree/InvenTree). Single tenant
today; architecture supports adding more tenants later without core
code changes (see Decision below).

Full design rationale: `docs/superpowers/specs/2026-09-18-stationary-inventory-design.md`

## Current Setup (this tenant: "stationary")

- **Runtime**: Native Python (venv), not Docker. Docker Desktop
  requires macOS 14+; this machine runs macOS 13.7 and Colima/qemu
  fails to build/run on this OS version. InvenTree runs fine as a
  plain Django app via `invoke`/`manage.py`.
- **Source**: `inventree-src/` — shallow clone of the official
  InvenTree repo, Python 3.12 venv at `inventree-src/.venv`.
- **Database**: Supabase-hosted Postgres (not local). Connection
  config lives in `inventree-src/.env` (gitignored — has DB
  password). `~/.pgpass` on this machine also has the Supabase
  credentials for passwordless `psql` access.
- **URL**: http://localhost:8000
- **Accounts**:
  - Admin: `anishbalami` (full access)
  - Staff: `shop_staff` (view + adjust stock only, via the "Staff"
    permission group — no delete, no settings access)
- **Data configured**: 6 Part Categories (Pens & Writing, Notebooks &
  Paper, Files & Folders, Art Supplies, Office Consumables, Stationery
  Sets), root Stock Location "Main Store".

## Running It

```bash
cd inventree-src
set -a; source .env; set +a
source .venv/bin/activate

# web server
python3 src/backend/InvenTree/manage.py runserver 0.0.0.0:8000

# background worker (separate terminal/process)
invoke worker
```

## Tenant Isolation Model

**Instance-per-tenant.** Each tenant (shop / future industry) gets its
own InvenTree deployment and its own database. No InvenTree core code
is modified to support multiple tenants — isolation comes from running
separate instances, not from shared multi-tenant application logic.
Full reasoning in the design spec linked above.

This was chosen over schema-per-tenant or shared-DB-with-tenant_id
because InvenTree (Django) has no built-in tenant-routing layer;
either of those alternatives would mean forking and maintaining
changes to InvenTree's core against every upstream update.

## Provisioning a New Tenant

To stand up another tenant (another shop, or a different industry
vertical later):

1. **New database**: create a new Supabase project (or any Postgres
   instance) for that tenant. Note host, port, db name, user,
   password.
2. **New working copy**: `git clone` InvenTree fresh (or copy
   `inventree-src/` minus `.venv` and `.env`) into a new directory for
   that tenant.
3. **New `.env`**: copy `inventree-src/.env` as a starting point, swap
   in the new tenant's DB connection details. Keep
   `INVENTREE_CACHE_ENABLED=False` (or stand up Redis per-tenant if
   you want caching) and set fresh local
   `INVENTREE_STATIC_ROOT` / `INVENTREE_MEDIA_ROOT` /
   `INVENTREE_BACKUP_DIR` / `INVENTREE_SECRET_KEY_FILE` paths inside
   that tenant's own directory (don't share these across tenants).
4. **Python env**: `python3.12 -m venv .venv`, activate, `pip install
   invoke`, then `invoke install`.
5. **First boot**: `invoke update` (runs migrations, builds frontend,
   collects static files), then `manage.py createsuperuser --noinput`
   with `DJANGO_SUPERUSER_USERNAME` / `_EMAIL` / `_PASSWORD` env vars
   set for that tenant's admin.
6. **Configure the vertical**: create that industry's Part Categories
   and Stock Location tree via the Django shell or the UI — this is
   where "stationary shop" vs. some other industry actually differs;
   no code changes needed, just different category/location data.
7. **Roles**: recreate a "Staff" permission group (or whatever roles
   that tenant needs) — see `docs/superpowers/specs/2026-09-18-stationary-inventory-design.md`
   for the exact permission set used for the stationary tenant's Staff
   group.
8. **Run** the new instance on its own port (e.g. `runserver
   0.0.0.0:8001` for the second tenant) so it doesn't collide with an
   existing running instance.

No shared code changes are required to onboard a tenant under this
model — every step above is "repeat the process with new config," not
"write new application logic."

## Deferred / Not Yet Done

- Production deployment (Zunkiree VPS via CI/CD) — currently local
  only.
- InvenTree plugin/frontend customization — none yet; revisit once
  real usage surfaces concrete needs.
- Purchase orders / supplier / manufacturing workflows — not set up,
  add only if needed.
