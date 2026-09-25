# Sales History Endpoint — Plan

> **Status: backend-only prerequisite for the future Sales → Sales History screen** (per `docs/superpowers/plans/2026-09-21-stationery-product-ui.md` §18). No frontend, no other API changes, no DB schema change.

## Endpoint Contract

`GET /plugin/stationerysales/movements/`

Read-only. Lists existing `SaleTypeMovement` rows — no new model, no duplicated transaction data. This is the "all movement types, unified" view the product UI plan flagged as missing (Sales History needs every type — B2B/cash/online/gift/restock/correction — in one feed; today only B2B surfaces via invoices, and everything else only via aggregated reports).

## Response Shape

```json
{
  "count": 142,
  "results": [
    {
      "id": 501,
      "created_at": "2026-09-21T10:32:00Z",
      "sale_type": "b2b_credit",
      "part_id": 34,
      "part_name": "Notebook A5",
      "quantity": "10.00000",
      "unit_value": "100.00000",
      "total_value": "1000.00000",
      "customer_id": 17,
      "customer_name": "Acme Stationers",
      "created_by_id": 4,
      "created_by_username": "anishbalami",
      "notes": "",
      "invoice_id": 88,
      "invoice_reference": "INV-0088"
    }
  ]
}
```

- `customer_id`/`customer_name` — `null` for non-B2B (matches `SaleTypeMovement.customer` being null except for `b2b_credit`, unchanged existing behavior).
- `invoice_id`/`invoice_reference` — `null` unless this movement is a B2B_credit row that was actually invoiced. Derived from the existing `InvoiceLineItem.sale_type_movement` one-to-one relation (`related_name='invoice_line'`) — no new field, no new model. Every current `b2b_credit` movement is invoiced (only `RecordB2BSaleView` ever creates one, and it always creates the `InvoiceLineItem` in the same atomic block), so in practice this is non-null for every `b2b_credit` row today — but the response derives it live rather than assuming, so it degrades to `null` safely if that ever changes.
- `sale_type` stays the raw backend value (`b2b_credit`, `b2c_cash`, `b2c_online`, `gift`, `restock`, `correction`) — never relabeled or collapsed into "sale" for any of them, matching the explicit instruction that the 6 types stay distinct so the frontend can style each one.
- Envelope: `{count, results}` rather than a bare array (departure from this plugin's other list endpoints, e.g. `invoices/`) — justified below under Pagination.

## Filters

All via query params, combinable:

- `date_from` / `date_to` — ISO `YYYY-MM-DD`, inclusive, filtered on `SaleTypeMovement.created_at` (date part). Same semantics, same param names, same field-choice reasoning as the Sales/Gift report endpoints (movement date is the only date a movement has — no invoice/payment date to borrow, and using the same param names as the reports means the frontend's existing `ReportDateRangeFilter` component works here unmodified).
- `sale_type` — one or more values, comma-separated (e.g. `?sale_type=b2b_credit,gift`) — matches the product UI plan's "type filter (multi-select chips)" requirement directly; a single-value-only filter would force the frontend into N separate requests to build a multi-type view.
- `customer` — `customer_id`, exact match — matches the product UI plan's per-customer filter (relevant mainly when viewing a customer's own transaction history, or filtering B2B activity).

**Not added**: a part/product filter. The product UI plan's Sales History filter row only specifies date + type + customer; a part filter isn't part of the planned screen, and adding one now would be a "genuinely useful" judgment call not backed by an actual UI requirement — skipped per the explicit "only add filters that are genuinely useful" instruction. Easy to add later against the same queryset if the UI plan grows to need it.

No generic query engine, no arbitrary field/operator combinators — four fixed, named filters, same shape as every other endpoint in this plugin.

## Query Strategy

Single queryset, `select_related` for every FK actually rendered per row (avoids N+1 across up to hundreds of rows):

```python
SaleTypeMovement.objects.select_related(
    'part', 'customer', 'created_by', 'invoice_line__invoice'
)
```

- `part`, `customer`, `created_by` — direct FKs already on the model.
- `invoice_line__invoice` — reverse one-to-one (`InvoiceLineItem.sale_type_movement`, `related_name='invoice_line'`) chained to its own FK (`InvoiceLineItem.invoice`) — Django's `select_related` supports reverse OneToOne traversal exactly like a forward FK, so this stays a single JOINed query, not a per-row lookup.

No `prefetch_related` needed — every relation involved is a to-one relation (FK or reverse-O2O), which `select_related` (SQL JOIN) already covers; `prefetch_related` (separate query + Python-side join) would only be needed for a to-many relation, and there isn't one here.

Filtering happens on the queryset before slicing (`WHERE` clauses, not Python-side filtering) — `date_from`/`date_to`/`sale_type`/`customer` all translate directly to `.filter()` calls.

## Pagination

**Departure from this plugin's existing list endpoints** (`invoices/` returns a bare array, no pagination) — justified specifically for this endpoint:

- `Invoice` rows only exist for `b2b_credit` sales — inherently a small, slow-growing table for a stationery retailer.
- `SaleTypeMovement` rows exist for **every** sale, gift, restock, and correction — this table grows continuously and, over a year of normal shop operation, plausibly reaches thousands of rows. Returning all of them unpaginated on every Sales History page load doesn't stay "simple and predictable" as the dataset grows — it gets slower and heavier over time with no bound.

Chosen approach: simple `limit`/`offset` query params (default `limit=50`, hard cap `limit<=200`), always ordered `-created_at` (most recent first — matches `SaleTypeMovement.Meta.ordering` already, and matches the Sales History screen's actual use case of "show recent activity, load more on demand"). This is **not** InvenTree's own DRF `LimitOffsetPagination`/`PageNumberPagination` machinery (that's designed around `GenericAPIView`+`ModelSerializer`, which this plugin deliberately doesn't use anywhere) — it's the same hand-rolled style as the rest of this plugin, just with two more query params and a `count` in the envelope, not a generic InvenTreeTable-shaped contract (no `next`/`previous` URLs, no DRF-specific pagination class).

## Authentication

`IsAuthenticated` — identical to every other endpoint in this plugin. No role-specific permission, no frontend-only authorization, matching instruction.

## Sale Types

Preserved exactly as stored: `b2b_credit`, `b2c_cash`, `b2c_online`, `gift`, `restock`, `correction`. Never collapsed or relabeled server-side — the response field is literally `SaleTypeMovement.sale_type`, passed through unchanged, so the frontend's future type-badge system (per the product UI spec) has the real distinction to key off.

## Migration

**None required.** No new fields, no new model — every value in the response comes from `SaleTypeMovement`'s existing fields plus the existing `InvoiceLineItem`→`Invoice` relation, both already in the schema from prior committed migrations (`0001_initial`, `0002_invoice_invoicelineitem_payment`).

## Test / Smoke-Test Strategy

Same live-smoke-test pattern used throughout this plugin (Django `manage.py test` still can't discover the dynamically-registered plugin app against Supabase — confirmed repeatedly in prior phases). Matrix, mapped to the 12 items requested:

1. Unauthenticated request → 401.
2. Empty result (`count: 0, results: []`) before any fixture data exists.
3. Mixed types — create one of each of the 6 sale types, confirm all 6 appear with correct `sale_type` values, none relabeled.
4. `date_from` excludes movements before it.
5. `date_to` excludes movements after it.
6. `sale_type` filter (single and comma-separated multi-value) returns only matching rows.
7. `customer` filter returns only that customer's movements; correct `customer_id`/`customer_name` populated for B2B, `null` for non-B2B.
8. Correct `quantity`/`unit_value`/`total_value` per row, matching what was recorded.
9. B2B movement's `invoice_id`/`invoice_reference` correctly derived and non-null; non-B2B movements have both `null`.
10. No cross-tenant/unrelated-record leakage — a movement created for a different disposable part/customer than the one being queried doesn't appear when filtered.
11. Regression: all 3 existing reporting endpoints still return 200 with correct data after this change.
12. Regression: existing B2B sale, payment recording, and gift-recording flows still work unchanged.

All fixtures use the established `SMOKETEST-` naming prefix and are deleted at the end of the run, with the same `delete_owner`-signal-bug raw-SQL fallback already documented from prior phases if a disposable `Company` row needs cleanup.

## Stop Conditions Checked — none hit

- `SaleTypeMovement` data is sufficient — every requested field maps directly to an existing column or a one-hop existing relation.
- Invoice relationship is reliably derivable — `InvoiceLineItem.sale_type_movement` is a real `OneToOneField`, not a guess or a heuristic join.
- Pagination semantics are not ambiguous — resolved above with a concrete, justified, non-generic design.
- No InvenTree core modification needed — plugin-only, same as every prior phase.
- No schema change needed — confirmed no migration.
