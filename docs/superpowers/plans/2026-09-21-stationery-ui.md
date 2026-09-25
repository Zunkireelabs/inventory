# Stationery UI — Frontend Architecture Audit + Plan

> **Status: AUDIT + PLAN ONLY. No frontend code written. No files modified, staged, or reverted.**

**Scope:** determine the minimum production-quality frontend needed to expose the completed stationery backend (sale-type recording, B2B invoices/payments, 3 reporting endpoints) inside InvenTree's existing React frontend, without a rewrite and without a separate app.

---

## 1. Current frontend architecture

InvenTree's frontend (`src/frontend/`) is React + TypeScript, Mantine UI, React Router, TanStack React Query, i18n via `@lingui`. Key facts, with exact references:

- **API client**: single shared axios instance — `export const api = axios.create({})` (`src/App.tsx:9`), base URL set at runtime via `getHost()`. All data-fetching goes through this instance plus React Query (`useQuery`/`useSuspenseQuery`). **This is directly reusable for our plugin's non-standard `/plugin/stationerysales/...` URLs** — they don't need to be in InvenTree's OpenAPI schema to be called this way; a plain `api.get('/plugin/stationerysales/reports/sales/')` inside a `useQuery` works exactly like any other frontend data call.
- **Tables**: generic `InvenTreeTable` component family under `src/tables/` — every existing list view (companies, stock, orders) is a thin wrapper configuring columns/filters over this generic table. New list UIs (e.g. an invoice list) should follow this same wrapper pattern rather than hand-rolling a table.
- **Forms/modals**: `useCreateApiFormModal` / `useEditApiFormModal` / `useDeleteApiFormModal` (`src/hooks/UseForm.tsx:98,118,169`) wrap a generic `ApiForm` component. By default, `ApiForm` auto-generates its field schema via an OPTIONS-introspection query (`optionsQuery`, `src/components/forms/ApiForm.tsx:84`) against the target DRF endpoint. **Our plugin endpoints are hand-rolled `APIView`s (not `ModelSerializer`/`GenericAPIView`), so they have no OPTIONS-introspectable schema.** This is not a blocker: `ApiForm`/the modal hooks accept an explicit static `fields` object that overrides/bypasses introspection — confirmed by existing usage (`src/tables/company/CompanyTable.tsx:90,103` passes `fields: companyFields()`, a plain object). **Our forms will supply a hand-written `fields` object** (e.g. `recordSaleFields()`, `recordPaymentFields()`) — same pattern, no core changes needed.
- **Routing**: `src/router.tsx` — every page is `Loadable(lazy(() => import('./pages/...')))`, then wired to a path elsewhere in the same routing tree. New top-level pages (e.g. Reports) follow this exact pattern: one lazy import + one route entry.
- **Detail-page panels**: existing detail pages (e.g. `src/pages/company/CompanyDetail.tsx`) build a `PanelType[]` array (`companyPanels`, `CompanyDetail.tsx:99`) of tabs — `details`, `supplied-parts`, `sales-orders`, `contacts`, etc., several of them conditionally shown based on company flags (mirrors exactly what we'd want for a `receivables` tab shown only when `company.is_customer`).
- **Dashboard**: `src/pages/Index/Home.tsx` renders `DashboardLayout`, a user-configurable widget grid (`react-grid-layout`, drag/resize/select). Available widgets come from `useDashboardItems()` (`src/hooks/UseDashboardItems.tsx:31`), which merges `DashboardWidgetLibrary()` — **a hardcoded, in-repo array of built-in widgets** (`src/components/dashboard/DashboardWidgetLibrary.tsx`) — with any plugin-contributed ones. Since built-in widgets are just entries in a core array, and we've decided to extend core directly (see §7), **adding stationery stat-cards to this same array is low-cost and available**, not a separate infrastructure project.
- **Permissions**: `src/states/UserState.tsx` — `user.is_staff` (line 112/129), `hasViewVisible(role: UserRoles)` (line 162), `hasAddPermission(model: ModelType)` (line 194). This is the existing, sole source of truth the frontend already uses everywhere to show/hide UI — no separate authorization system exists or should be invented.
- **Responsive behavior — corrected finding.** Grepping the whole frontend for `useMediaQuery`/`visibleFrom`/`hiddenFrom` returns only **2 files in the entire codebase** (`DetailsImage.tsx`, `PageDetail.tsx`). The dashboard grid's `react-grid-layout` `Responsive`/`WidthProvider` wrapper only reflows *widget tiles*, not the app's general layout — it is not evidence of app-wide mobile support. **The existing InvenTree frontend is, in practice, desktop-first; genuine responsive/mobile patterns are barely used anywhere in this codebase.** Custom Mantine breakpoints exist (`ThemeContext.tsx`) but aren't widely leveraged. This is a real gap relative to the "responsive web application" requirement — see §9 for the honest strategy given this baseline, and §12 for why it's flagged as a concern rather than assumed solved.
- **Plugin-contributed remote UI (`UserInterfaceMixin`) — full mechanism confirmed.** `plugin/base/ui/mixins.py`'s `CustomPanelOptions`/`CustomDashboardItemOptions` (Python) surface to the frontend via one generic endpoint, `ApiEndpoints.plugin_ui_features_list` = `plugins/ui/features/:feature_type/`. Working consumers exist for 3 of the 7 declared feature types: `panel` (`src/hooks/UsePluginPanels.tsx`, consumed generically inside `PanelGroup.tsx:232` — meaning **every** detail page built on `PanelGroup`, including `CompanyDetail`/`SalesOrderDetail`/`PartDetail`/`StockDetail`, automatically supports plugin-injected tabs with zero per-page code changes), `dashboard` (`UseDashboardItems.tsx:42-57`), and `spotlight_action` (command palette, `Layout.tsx:77-92`). `navigation`/`primary_action` are declared in the type enum but have **zero consumers** — not usable today, confirming §1's earlier point that there's no working nav-injection mechanism for plugins.
  Rendering goes through `RemoteComponent`/`useRemotePlugin` (`src/hooks/UseRemotePlugin.tsx`): the API-supplied `source` string is resolved to a URL and the browser does a genuine runtime `import(moduleUrl)` of a JS file the **plugin itself must build and serve** — confirming a plugin cannot embed already-bundled InvenTree React components directly. **Correction to an earlier draft of this finding:** the exported function *does* receive a rich `InvenTreePluginContext` (`lib/types/Plugins.tsx:112-147`) that hands the remote module the shared `api` axios instance, `queryClient`, user/settings state, `forms` (the same `useCreateApiFormModal`/edit/delete modal openers), `tables.renderTable` (the same `InvenTreeTable`), and `theme`/`colorScheme` — so a remote-loaded panel *can* render real InvenTree tables/forms/modals through context, it is not limited to hand-rolled HTML. The genuine cost is **infrastructure, not component reuse**: a second Vite build (library mode) inside the Python plugin package, a way to serve the built JS as a static file, and Vite-HMR-aware dev tooling if live-editing that bundle during development — a real, separate toolchain change regardless of what it can render. See §7 for the recommendation given this corrected, fuller picture.

## 2. Existing frontend diff analysis

All 9 modified frontend files (+ `.gitignore`) are **uncommitted, pre-existing, and unrelated to the stationery backend work** — confirmed via `git diff` content inspection and file mtimes (all Sept 18, 15:05–16:45, a full day before any stationery-plugin commit). Two distinct, already-in-flight efforts are mixed together in this diff:

**A. "ITS" rebrand** (cosmetic, tenant identity):
- `index.html` — page `<title>` `InvenTree` → `ITS`.
- `InvenTreeLogo.tsx` — replaces the InvenTree SVG logo with an inline "ITS" wordmark badge; alt text updated.
- `MainMenu.tsx` / `defaults/actions.tsx` — removes the "About InvenTree" menu item and command-palette action (de-branding).

**B. Stationery-tenant business-logic hiding** (already-established precedent, self-documented):
- `defaults/links.tsx` — Manufacturing nav tab forced `visible: false`, comment: `// Hidden for the stationary-shop tenant: manufacturing/BOM is not used.`
- `components/nav/NavigationDrawer.tsx` — same treatment for the Manufacturing drawer entry, identical comment.
- `pages/purchasing/PurchasingIndex.tsx` — "Manufacturers"/"Manufacturer Parts" filter views hidden, same comment pattern.
- `locales/en/messages.po` — genuine `msgstr` content changes renaming "Part"→"Product" throughout the UI strings (89 additions / 90 removals sampled), mixed in with ~16,000 lines of mechanical `lingui` regeneration formatting noise. This is the **frontend half of the same Part→Product terminology rename** whose backend half was committed separately (`4a9e161aca`) — but this frontend half predates that commit by a day and was never committed itself.

**C. Package-manager migration** (tooling, in-progress, unrelated to UI):
- `yarn.lock` (12,836 changed lines), `package.json`, plus untracked `.yarnrc.yml` and `.yarn/` — a **Yarn Classic (v1) → Yarn Berry migration**, confirmed by lockfile header format change. This is uncommitted and mid-flight; frontend tooling is not currently in a clean, reproducible state (a fresh clone + `yarn install` elsewhere would regenerate a Classic-format lock and diverge).

**Direct relevance / overlap risk — confirmed YES:** `NavigationDrawer.tsx`, `defaults/links.tsx`, and `PurchasingIndex.tsx` are **exactly the files** a stationery nav entry would need to edit (adding entries to the same `DrawerContent` array / same tab-visibility array). `InvenTreeLogo.tsx`/`MainMenu.tsx` are exactly where stationery branding would land too. **This is not a coincidence to route around — it's direct evidence that a "core + tenant customization" approach for this deployment was already chosen and partially executed**, which materially informs the recommendation in §7 below. Any future stationery UI work editing these same files will be layering on top of this existing uncommitted diff, not creating a new conflict from nothing.

**Not touched, not relevant:** `.gitignore` (`.env` ignore rule, generic hygiene). `.claude/`, `skills-lock.json` (tooling artifacts, no UI relevance).

## 3. Reusable InvenTree components (confirmed, by name)

- `InvenTreeTable` family (`src/tables/`) — for Invoice list, Payment history list.
- `useCreateApiFormModal` / `useEditApiFormModal` (`src/hooks/UseForm.tsx`) with hand-written `fields` objects — for Record Sale, Record Payment.
- `PanelType[]` pattern (`src/pages/company/CompanyDetail.tsx`) — for adding a "Receivables" tab to the existing Company detail page.
- `Loadable(lazy(...))` + router entry pattern (`src/router.tsx`) — for new top-level pages (Invoice detail, Reports).
- `DashboardWidgetLibrary()` (`src/components/dashboard/DashboardWidgetLibrary.tsx`) — for optional stationery stat-cards on the home dashboard.
- `UserState` permission helpers (`hasViewVisible`, `is_staff`) — for all visibility gating.
- Mantine components throughout (`Stack`, `Group`, `Card`, `SimpleGrid`, `Table`, stat-card patterns) — no new component library needed.

## 4. Proposed navigation

Inspected existing nav (`NavigationDrawer.tsx`, `defaults/links.tsx`) before proposing anything — it's a flat set of top-level entries (Home, Parts, Stock, Purchasing, Sales, Build [hidden for this tenant], plus Admin/Settings), each with a `hidden`/`visible` predicate driven by `UserRoles`.

**Recommended additions** — two new top-level entries, not a restructure:
- **Sales** *(likely already exists as a core entry — if so, extend it; do not duplicate)* → add a "Record Sale" action reachable from here.
- **Receivables** *(new)* → invoice list, portfolio view. (Per-customer receivables live as a tab on the existing Company detail page, not a duplicate page — see §5.)
- **Reports** *(new)* → 3 sub-views: Sales, Receivables, Gifts.

Do **not** introduce a separate "Inventory" top-level entry — Stock/Purchasing already cover that; restock/correction recording attaches to the existing Stock item detail page (see §5), not a new nav section.

## 5. Proposed screens (minimum coherent set)

**5.1 Record Sale — one unified screen, not six.** The backend's `record-sale/` already takes a single `sale_type` discriminator with conditional fields (`customer_id` only for `b2b_credit`); `record-b2b-sale/` is the one exception with its own extra field (`due_date`) and its own invoice-creating side effect. Recommendation: **one modal** ("Record Sale") with a `sale_type` selector; when `b2b_credit` is selected, reveal `customer_id` + `due_date` and submit to `record-b2b-sale/` instead of `record-sale/`. This matches "prefer one coherent workflow where it improves usability" — five of six sale types share an identical, trivial field set (stock item, quantity, unit value, notes), and forcing six separate screens would be worse UX for zero benefit. Launched from the Stock item detail page (an action button, consistent with how other stock actions already work there) *and* from the Sales nav entry (a stock-item picker + the same modal).

**5.2 Invoice list** — new page, `InvenTreeTable`-based, under **Receivables**. Columns: reference, customer, status, total, outstanding, due date, aging bucket.

**5.3 Invoice detail** — new page (routed, per §1's router pattern). Shows invoice fields, line items (from `GET /invoices/<pk>/`), payment history table (from `GET /invoices/<pk>/payments/`), and a "Record Payment" modal (`POST` to the same URL) using a hand-written `fields` object (amount, method, payment_date, reference).

**5.4 Customer receivables** — **not a new page**: a new tab (`PanelType`) on the existing `CompanyDetail.tsx`, shown only when `company.is_customer`, pulling `GET /customers/<pk>/receivables/`. Direct reuse of an existing detail page rather than a duplicate customer view — matches the audit's explicit ask to determine this.

**5.5 Reports — dedicated pages, plus optional dashboard cards.** Three focused pages (Sales / Receivables / Gifts) under **Reports**, each: a date-range filter (`date_from`/`date_to`, matching the API contract exactly) + summary stat cards + one breakdown table (`by_sale_type` / `aging` + `by_customer` / `by_part`). No generic report-builder, no chart library introduced beyond what Mantine already offers — the data is a handful of aggregate numbers, not a visualization problem. **Optionally**, top-line numbers (e.g. "Outstanding Receivables", "This Month's Sales") can additionally be added as 1-2 small entries in `DashboardWidgetLibrary()` for at-a-glance visibility — low cost since it's a core array we're already extending, not a blocker for the initial pages.

## 6. Proposed components (net-new, all thin)

- `RecordSaleModal` (wraps `useCreateApiFormModal`, conditional fields by `sale_type`).
- `RecordPaymentModal` (wraps `useCreateApiFormModal` against the payments endpoint).
- `InvoiceTable` (wraps `InvenTreeTable`, no model registered in InvenTree's model registry so this will be a manually-configured table pointed at our URL, not the usual `ModelType`-driven auto-table).
- `PaymentHistoryTable` (same pattern, nested under Invoice detail).
- `CustomerReceivablesPanel` (new `PanelType` content component for `CompanyDetail.tsx`).
- `SalesReportPage`, `ReceivablesReportPage`, `GiftReportPage` (each: date filter + stat cards + one table, near-identical shape — a shared `ReportPageLayout` wrapper is reasonable to avoid copy-paste, still not a "generic report builder" since the three pages remain distinct routed pages with hand-written field mappings).

## 7. API integration mapping

| Screen | Endpoint | Notes |
|---|---|---|
| Record Sale modal (non-B2B) | `POST /plugin/stationerysales/record-sale/` | Hand-written `fields` object (ApiForm can't introspect a plain `APIView`) |
| Record Sale modal (`b2b_credit`) | `POST /plugin/stationerysales/record-b2b-sale/` | Same modal, different endpoint on type-select |
| Invoice list | *(new, not yet built — see §12 concern)* | Backend has no `GET /invoices/` list endpoint today, only `GET /invoices/<pk>/` |
| Invoice detail | `GET /plugin/stationerysales/invoices/<pk>/` | Direct `useQuery` + `api.get` |
| Payment history | `GET /plugin/stationerysales/invoices/<pk>/payments/` | `InvenTreeTable`-style list, or plain table given small row counts |
| Record Payment modal | `POST /plugin/stationerysales/invoices/<pk>/payments/` | Hand-written `fields` object |
| Customer Receivables tab | `GET /plugin/stationerysales/customers/<pk>/receivables/` | New `CompanyDetail` panel |
| Sales report | `GET /plugin/stationerysales/reports/sales/` | `date_from`/`date_to` query params map directly to a date-range picker |
| Receivables report | `GET /plugin/stationerysales/reports/receivables/` | Same |
| Gift report | `GET /plugin/stationerysales/reports/gifts/` | Same |

**Pattern for all of the above:** plain `api` axios instance + React Query `useQuery`/`useMutation` — no new API-client abstraction needed (§1).

## 8. Owner/Staff UI visibility

No new authorization system — reflects backend auth exactly, per instruction. Current backend state: **every stationery endpoint requires only `IsAuthenticated`**, with no `is_staff`/role restriction implemented on the backend today (confirmed across all 8 plugin endpoints). Therefore, at present, **frontend visibility should not restrict stationery UI beyond `IsAuthenticated`** either — gating stationery nav/screens behind `is_staff` in the frontend while the backend allows any authenticated user would be exactly the "pretending to enforce security the backend doesn't" anti-pattern the brief explicitly warns against. If Owner-vs-Staff distinction is actually wanted (e.g. "Staff can record sales but not view portfolio-wide Reports"), **that constraint needs to be added to the backend first** (a real permission class per view) — this is called out as an open question in §12, not decided unilaterally here.

## 9. Responsive strategy (honest baseline, not assumed)

**Correcting an easy-to-get-wrong assumption:** the existing InvenTree frontend is *not* meaningfully responsive today — only 2 files in the entire codebase use any media-query/breakpoint-aware component (§1). The dashboard's drag-resize grid is not evidence of general mobile support. So "reuse existing responsive patterns" is not really available as a strategy here — there's almost nothing to reuse.

Given "do not introduce a new frontend framework," the realistic approach is: use Mantine's *already-available-but-underused* primitives directly in our new components (`SimpleGrid` with responsive `cols` prop for stat cards, `Group`/`Stack` for stacking, `Table.ScrollContainer` for horizontal-scrolling tables on narrow viewports, the existing custom breakpoints in `ThemeContext.tsx`) — Mantine supports this out of the box, we're just the first stationery-specific screens to actually lean on it. This is achievable without touching core, but it means our new screens will be *more* responsive than the InvenTree pages around them, not matching an established pattern — worth setting that expectation rather than implying parity with existing polish that doesn't exist.

## 10. Implementation order (once this plan is approved for building)

1. Company detail — Receivables tab (smallest, fully self-contained, reuses an existing page).
2. Record Sale modal (unifies 6 sale types into 1 screen; unblocks daily operational use immediately).
3. Invoice detail page + Record Payment modal.
4. Invoice list page (**blocked on a backend gap — see §12**).
5. Reports pages (Sales, Receivables, Gifts) — independent of the above, could be done in parallel/first if preferred.
6. Optional: dashboard stat-cards.

## 11. Testing strategy

Matches this project's established pattern: `manage.py test` remains unavailable for backend verification (unchanged), and there is no existing frontend test suite convention observed in this audit to extend (not investigated deeply here — out of scope for a backend-facing audit; flag for the implementation phase to check `src/frontend/` for any Vitest/Playwright setup before assuming none exists). For UI verification: manual click-through against the running dev server (`yarn dev` / existing frontend dev workflow) hitting the real plugin endpoints on the Supabase dev DB, using the same `SMOKETEST-` disposable-data-and-cleanup convention already established for backend smoke tests.

## 12. Rollback/safety considerations

- All new frontend work is additive (new files, new array entries) — no deletions of existing InvenTree UI beyond what's already staged in the pre-existing "stationary-tenant" diff (§2), which this plan does not touch.
- The pre-existing uncommitted diff (§2) is **not required** for the stationery UI to function — the new pages/components described here don't depend on the ITS-rebrand or Part→Product frontend changes being present or committed. They're independent, just colocated in the same files for nav-entry additions (§2's overlap risk means *merge conflicts to resolve*, not a *functional dependency*).
- No InvenTree core Python/backend files touched by this plan — frontend-only.
- No new frontend framework, no new build pipeline (rejecting the `UserInterfaceMixin` remote-JS-module route for this reason — see §1 and below).

---

## Architectural concerns / stop-condition check

**Recommendation: extend `src/frontend` directly (core-frontend-extension) as the primary approach, with `UserInterfaceMixin` panels as a legitimate option specifically for the Company-receivables-tab piece if a fully plugin-contained UI is later preferred.** Both are real, working options — not "one viable, one broken" — so this is a judgment call, not a forced conclusion. Reasoning for the primary recommendation:
1. `UserInterfaceMixin` genuinely does let a remote panel/dashboard module reuse InvenTree's real `api` client, `forms` (the same modal openers this plan uses in §1/§6), and `tables.renderTable` via the `InvenTreePluginContext` passed into it (confirmed, §1) — so the earlier concern that it can't reuse InvenTree's component system was too strong; it can. The genuine, remaining cost is **infrastructure**: a second Vite build (library mode) living inside the Python plugin package, a static-file serving path for the built JS, and separate dev/HMR tooling — a real second toolchain regardless of what it renders.
2. `navigation`/`primary_action` plugin feature types are declared but have **zero working consumers** (§1) — so even fully committing to `UserInterfaceMixin`, the Reports/Receivables top-level nav entries and the Invoice-list page still cannot be plugin-injected today; they would need router/nav file edits in core regardless. This means **core-frontend edits are not avoidable either way** for a chunk of this plan (nav entries, Invoice detail/list routes) — the only piece genuinely swappable between the two approaches is the Company-detail Receivables *tab*, since `PanelGroup` (§1) already generically supports plugin-injected panels with zero core changes.
3. The repo has **already chosen and partially executed** the core-frontend-extension approach for this exact tenant (§2's "stationary-shop tenant" comments already in `NavigationDrawer.tsx`/`links.tsx`/`PurchasingIndex.tsx`) — following that precedent for the pieces that need core edits anyway (nav, routes) is more consistent than introducing a second toolchain alongside it just for the one tab that could go either way.

**Given point 2, this is a mixed/hybrid recommendation, not a clean either/or**: nav entries, Invoice detail/list pages, and the Record Sale/Payment modals are core-frontend additions regardless of choice (no plugin-injection path exists for them today). The **only genuinely open decision** is whether the Company Receivables tab (§5.4) is built as a `PanelType` entry in `CompanyDetail.tsx` (core edit, zero new infra, consistent with everything else in this plan) or as a `UserInterfaceMixin` `panel` feature (zero core edit for that one tab, but stands up a new build/serve toolchain for a single screen). **Recommendation: the core-edit path for the tab too**, purely on cost grounds — one new toolchain for one tab isn't worth it when the rest of the plan already requires core edits — but this is flagged explicitly as a judgment call for review, not a stop condition.

**No stop condition was hit** — no core InvenTree Python modification needed (frontend-only work), no material conflict with the existing frontend diff (overlap is additive/positional, not functional — confirmed §2/§12), authentication is clear (existing `IsAuthenticated`-only backend state, §8), the extension point is clear (§1/§3), and no major rewrite is implied (this is incremental page/panel/modal addition using 100% existing primitives).

**One real gap surfaced during this audit, not previously flagged:** there is **no `GET /plugin/stationerysales/invoices/` list endpoint** — only `GET /invoices/<pk>/` (single invoice) and `GET /customers/<pk>/receivables/` (per-customer, only non-zero-outstanding invoices) exist today. A portfolio-wide **Invoice list** page (§5.2, distinct from the Receivables *report*, which already has portfolio-wide data via `reports/receivables/`) has no backing endpoint yet. This is a **backend gap, not a frontend architecture problem** — flagging for a decision before Implementation Order step 4: either (a) add a simple list endpoint, or (b) drop the standalone Invoice list page and rely on the Receivables report + per-customer tab to reach any invoice, which may be sufficient depending on actual usage patterns. Not deciding this here — surfacing it for review.

**One product-permissions question, not an architecture question, surfaced in §8:** if Owner and Staff are meant to see different things beyond plain authentication, that requires a backend permissions decision first (new permission class(es) on specific views) — the frontend cannot and should not invent that distinction on its own.
