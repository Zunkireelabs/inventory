# BRIEF.md / SCOPE.md Gap Audit — InvenTree Base

Date: 2026-09-19

Source docs inspected: `BRIEF.md` and `SCOPE.md` (from the `inventory-stationary-app`
Next.js repo — same brief this InvenTree deployment is meant to satisfy).
InvenTree source inspected directly: `inventree-src/src/backend/InvenTree/{part,stock,order,company,report}/models.py`.

Purpose: determine exactly what SCOPE.md/BRIEF.md requires that InvenTree does
**not** already provide, and for each gap, what kind of work closing it requires
(plugin, custom Django app alongside InvenTree, or core model change).

---

## Summary verdict

InvenTree covers the generic inventory parts well (products, stock levels, stock
locations, roles/permissions, restock). It has **zero** native support for the
actual differentiator SCOPE.md §3 calls the whole point of this system:
**sale-type as a first-class dimension** (B2B-credit / B2C-cash / B2C-online /
Gift) and the B2B receivables/aging module built on top of it. These aren't
missing settings — they're missing *data model concepts*. Closing them means
adding new models, not configuring existing ones.

---

## Gap-by-gap

### 1. Sale-type dimension (SCOPE.md §3, §7 — "the hard part")

**Requirement:** every stock movement carries a `sale_type` tag
(`b2b_credit`/`b2c_cash`/`b2c_online`/`gift`) from the moment it's recorded, and
every downstream view derives from that tag.

**InvenTree today:** `StockItemTracking` (the stock movement history model) has a
`tracking_type` field, but its values are generic (`StockHistoryCode`:
`STOCK_ADD`, `STOCK_REMOVE`, `STOCK_COUNT`, order-linked codes like
`SENT_TO_CUSTOMER`, `RECEIVED_AGAINST_PURCHASE_ORDER`, etc.) — there is no
`b2b_credit`/`b2c_cash`/`b2c_online`/`gift` concept anywhere in the codebase
(confirmed: zero hits for "gift" across the entire backend). A `SalesOrder`
exists but is a single generic order type — no field distinguishes a credit
dispatch from a cash sale from an online sale.

**Gap size:** Large. This is the core requirement and InvenTree has no hook
resembling it. `StockHistoryCode` is a Python `StatusCode` enum baked into
`stock/status_codes.py` — extending it requires either patching that enum
directly (core fork, exactly what the InvenTree design spec said to avoid) or
building a **parallel model** that layers sale-type semantics on top of
`StockItemTracking`/`SalesOrder` without modifying them.

**How to close it:** Every model in InvenTree carries a `metadata` JSONField
(`MetadataMixin`) as a sanctioned extension point — you *could* stash
`{"sale_type": "b2b_credit"}` there without touching core models. But SCOPE.md
explicitly warns against exactly this pattern: *"not just a label on a
transaction... get this wrong at the schema level and every report built on top
inherits the error."* An unindexed JSON blob is precisely "just a label," not a
first-class queryable dimension. The correct close is a **custom Django app**
(installed alongside InvenTree, not forking it) with its own `SaleType` model
tied via FK to `StockItemTracking`/`SalesOrder`, exposed through InvenTree's
plugin API (mixins exist for adding new API endpoints/models: `AppMixin`,
`UrlsMixin`). This is real backend development, not configuration.

---

### 2. B2B receivables/aging module (SCOPE.md §6, §7 — "single most estimate-sensitive piece")

**Requirement:** invoice-level ledger, partial payments against a specific
invoice, per-customer statement, aging buckets (current/30/60/90+).

**InvenTree today:** `SalesOrder` + `SalesOrderLineItem` + `SalesOrderShipment`
exist, but there is **no payment model at all** — confirmed via direct grep of
`order/models.py`: no `class Payment`, no `amount_paid` field, no invoice
status beyond generic order status codes (`PENDING`, `IN_PROGRESS`, `SHIPPED`,
`COMPLETE`, `CANCELLED` — fulfillment states, not payment states). No aging
concept exists anywhere in the codebase.

**Gap size:** Large. This is a full accounts-receivable module SCOPE.md itself
calls "the single most estimate-sensitive piece of the build" — and InvenTree
has nothing resembling it, not even a partial primitive to extend.

**How to close it:** New models: `Payment` (FK to `SalesOrder`, amount, date,
method), a derived `balance`/`status` (open/partial/paid), and aging-bucket
logic (pure Python, can live in a plugin or a small custom app). This is the
Next.js app's `payments` table + `recalc_invoice_status` trigger +
`receivables.ts` logic, reimplemented in Django. Non-trivial — this is the
piece SCOPE.md itself flags as hardest, and it's 100% missing here.

---

### 3. Gift valuation as a reportable figure (SCOPE.md §6, §7)

**Requirement:** gift outbound tracked at cost or retail value (configurable
basis), rolls up into an owner "value given away" report without leaking into
revenue.

**InvenTree today:** No concept of a gift transaction exists at all (confirmed:
zero "gift" hits in the codebase). Closest primitive is `STOCK_REMOVE`
(generic manual stock removal) with no valuation-basis logic and no reporting
rollup.

**Gap size:** Medium — depends entirely on gap #1 existing first (gift is just
one `sale_type` value). Once sale-type exists as a real dimension, gift
valuation is "read the configured basis setting, compute quantity × price,
tag the movement" — straightforward once the foundation is there. Before that,
it doesn't exist to extend.

**How to close it:** A `GiftValuationBasis` setting (InvenTree already has a
`InvenTreeSetting`/`InvenTreeUserSetting` framework you'd hook into
appropriately) + valuation calculation at gift-recording time, part of the
same custom app as gap #1.

---

### 4. Customizable reporting — show/hide fields (SCOPE.md §6)

**Requirement:** owner can toggle which columns/fields show in reports, filter
by date range and sale type.

**InvenTree today:** `report/models.py` has `ReportTemplate`/`LabelTemplate` —
these are **PDF/label document generators** (invoices, packing slips, barcode
labels rendered as printable documents), not an interactive dashboard/table
column-toggle system. Not the same category of feature at all.

**Gap size:** Medium. No InvenTree primitive matches this — it's a frontend
feature (a table component with show/hide column state, same as the Next.js
app's `ReportTable` component) that would need to be custom-built in
InvenTree's React frontend (`src/frontend`), reading from whatever stock
movement / sale-type data gap #1 produces. Real frontend work, not
configuration — and the InvenTree design spec explicitly deferred "no custom
plugin or frontend work" for v1.

---

### 5. Roles — Owner/Admin vs Staff (SCOPE.md §6)

**Requirement:** two roles, owner has receivables/reporting/product-setup
access staff doesn't.

**InvenTree today:** Built-in Groups & Permissions system, already configured
per this project's own README (`Admin` group full access, `Staff` group
stock view/adjust only, no delete/settings). This is genuinely already done —
InvenTree's permission system is granular enough to express exactly this
split with zero code changes.

**Gap size:** None. Already closed, already working.

---

### 6. Inventory core — products, restock, movement history (SCOPE.md §6)

**Requirement:** add product (name, SKU, cost, retail, starting qty), restock
updates qty on hand, full movement history per product.

**InvenTree today:** `Part` model has `name`, `IPN` (≈SKU), pricing fields
(via `PartPricing`), and `StockItem`/`StockItemTracking` gives full movement
history with quantity deltas. This is InvenTree's core competency — fully
covered, already working (confirmed via the earlier backend Part→Product
rename session — the underlying data model is solid, only labels needed
changing).

**Gap size:** None. Already closed.

---

## What this means for scope/effort

Two of six requirement areas are **fully closed already** (roles, inventory
core) — InvenTree earns its keep here, this is exactly what a mature
open-source inventory tool is good at.

The other four — sale-type dimension, B2B receivables/aging, gift valuation,
customizable reporting — are **the entire differentiator SCOPE.md describes**,
and InvenTree has **no partial primitives** for any of them. This isn't
"configure existing InvenTree features to fit the brief" — it's "build a new
Django app (sale-type + payments + gift valuation models) plus new frontend
screens (reporting), installed alongside InvenTree via its plugin/app
mechanism, without forking core."

That is real, multi-week backend + frontend development — comparable in scope
to significant parts of what the Next.js app already built from scratch. The
InvenTree design spec's original v1 decision to defer "no custom plugin or
frontend work" directly conflicts with what SCOPE.md actually requires; that
deferral can't hold if this plan (InvenTree base + add the missing features)
is the one being pursued.

## Suggested build order (if proceeding on InvenTree)

1. **Sale-type foundation first** (gap #1) — everything else depends on it.
   New Django app (e.g. `stationery_ext`), one new model tying a sale-type enum
   to stock movements, installed as an InvenTree plugin (`AppMixin`).
2. **Gift valuation** (gap #3) — small addition once #1 exists.
3. **B2B receivables/aging** (gap #2) — largest single piece, can proceed in
   parallel with #1/#3 since it's a mostly-separate `Payment` model, but its
   UI (customer statements, aging view) depends on #1 for classifying which
   orders are B2B-credit in the first place.
4. **Reporting UI** (gap #4) — last, since it's a view over data produced by
   #1–#3.
