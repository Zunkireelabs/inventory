# Reporting Architecture Audit

> **Status: AUDIT ONLY. Nothing implemented. No code touched.**

**Scope of this audit:** determine what backend reporting/analytics data and mechanisms InvenTree already provides, and what (if anything) the `stationery_sales` plugin still needs to expose sale-type, receivables/aging, and gift-valuation reporting data. UI/dashboard rendering is explicitly out of scope per prior instruction ("reporting UI is not part of this task").

---

## 1. Data already available (no gaps)

Everything needed for sale-type / receivables / gift-valuation reporting already exists in the plugin's own models — confirmed by inspection, not assumption:

- **`SaleTypeMovement`** (`stationery_sales/models.py`): `sale_type` (`TextChoices` — `b2b_credit`/`b2c_cash`/`b2c_online`/`gift`/`restock`/`correction`), `quantity`, `unit_value`, `total_value`, `part`, `customer` (null except B2B), `created_by`, `created_at`. Immutable once created (no `save()` override, no `updated_at`). This alone supports "sales by type over any date range."
- **`Invoice`**: `status`, `total`, `due_date`, `outstanding` (computed property), `aging_bucket` (computed property, 5 buckets), `customer`. Supports receivables/aging reporting directly — the aging logic already exists per-invoice; a report is just an aggregation over it.
- **`Payment`**: `amount`, `method`, `payment_date`, `invoice`. Supports payment-history/collections reporting.

**Conclusion: no new fields, no new models, no migration needed to make this data reportable.** The gap (if any) is purely in *exposing an aggregation endpoint* — the raw data is already there.

## 2. InvenTree's `report/` app — not the right fit

`report/models.py` defines `ReportTemplate`/`LabelTemplate` (both subclass `ReportTemplateBase`), plus `plugin.base.integration.ReportMixin` (`plugin/base/integration/ReportMixin.py`). This is InvenTree's **printable document** engine — HTML/PDF templates bound to a *single model instance* (e.g. print one Invoice, one SalesOrder, one StockItem label), rendered via WeasyPrint-style templating, with a plugin hook (`ReportMixin`) to contribute report *context* for a single object. It has no concept of a date-ranged aggregate summary across many rows. **Not usable for "sales by type over time" or "total receivables" reporting** — that's a fundamentally different shape of report (many-rows-to-one-summary, not one-row-to-one-document).

## 3. InvenTree's dashboard-widget mechanism — real, but explicitly out of scope

`plugin.base.ui.mixins.UserInterfaceMixin` exists, with a `CustomDashboardItemOptions` TypedDict — this is InvenTree's actual plugin-contributed dashboard-panel system (a React component the plugin registers, rendered in the InvenTree UI's dashboard). This is the correct long-term home for a visual reporting dashboard. **Deliberately not touched by this audit** — it's UI work, and the standing instruction across this whole engagement has been "reporting UI is not part of this task" / "do not move to reporting or UI yet." Noting its existence now so the eventual UI phase doesn't have to re-discover it.

## 4. InvenTree's bulk data-export mechanism — an option, not a requirement

`plugin.base.integration.DataExport.DataExportMixin` + `common.models.DataOutput` is InvenTree's async bulk CSV/XLSX export framework (chunked, queryset-driven, `EXPORT_CHUNK_SIZE`). This is the right tool if the actual requirement turns out to be "let the user download a spreadsheet of raw movements/invoices." It is heavier than what a simple aggregate-summary API needs, and nothing in the brief so far has asked for file export specifically. **Available if needed later; not required for a summary/aggregation endpoint.**

## 5. No existing aggregation-endpoint convention in core to reuse

Searched `stock/api.py`, `part/api.py`, `order/api.py` for existing analytics-style endpoints (`Sum`/`Count`/`annotate`/date-trunc grouping). Found only one incidental `Count()` usage (`part/api.py:516`, an image-count aggregate unrelated to sales). **There is no canonical "dashboard summary" API pattern in core to extend or copy** — a reporting endpoint here would be a new, self-contained DRF `APIView` doing plain Django ORM aggregation, following the same house style already established in this plugin (hand-rolled `Response` dicts, no `serializers.py`, `IsAuthenticated`, matches `CustomerReceivablesView`'s existing shape almost exactly).

## 6. `part/stocktake.py` — parallel but unrelated

InvenTree has a separate `PartStocktake`-style mechanism (`part/stocktake.py`) for periodic on-hand-stock valuation snapshots (accounting/stock-value-over-time, a different domain: total inventory value, not sales activity). Confirmed unrelated to sale-type/receivables reporting — not a candidate to build on, and not a competing "canonical" mechanism for what we need (no ambiguity between them).

## 7. Recommended architecture (proposal only — not implemented)

One or more plain, read-only DRF `APIView` endpoints in `stationery_sales/api.py`, added under the existing `plugin:stationerysales:` URL namespace, each doing a Django ORM aggregation (`Sum`, `Count`, `annotate`, optionally `TruncMonth`/`TruncDate` for time-bucketing) over `SaleTypeMovement` and/or `Invoice`/`Payment`, parameterized by an optional date range via query params. No new models. No new migration. No serializers file (matches existing convention). This becomes the data source a future dashboard widget (`UserInterfaceMixin`) or export job (`DataExportMixin`) would consume — neither of which is being built now.

Candidate shapes (not committed to yet — for discussion before any plan-writing/implementation phase):
- Sales-by-type summary: total quantity/value per `sale_type`, optionally bucketed by month, over a date range.
- Receivables/aging summary: already have `CustomerReceivablesView` per-customer; a cross-customer aggregate (total outstanding per aging bucket, portfolio-wide) would be new.
- Gift valuation summary: total gift value given away over a date range (trivial `SaleTypeMovement.objects.filter(sale_type='gift').aggregate(...)`).

## 8. Stop conditions checked — none hit

- Reporting data source is not ambiguous (all three source models fully sufficient, confirmed above).
- No competing canonical mechanisms for the same job — `report/` (single-document printing), `UserInterfaceMixin` (dashboard UI), `DataExportMixin` (bulk export) each solve a *different* problem; none conflicts with a plain aggregation API.
- No InvenTree core change required — everything above is plugin-side only.
- No migration required — confirmed no new fields/models needed.
- `SaleTypeMovement`/`Invoice`/`Payment` structure confirmed sufficient for every reporting need identified so far.

## 9. Open question for you before a plan gets written

~~This audit deliberately stops short of picking exact endpoint(s)/response shape(s)~~ — **resolved below.** Scope approved: all three reports, three separate endpoints, no generic report-type param.

---

# Part 2 — Implementation Plan (approved scope)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or superpowers:subagent-driven-development to implement this plan task-by-task.
>
> **STATUS: PLAN ONLY — implementation has not started. Stop after this plan is written; get it reviewed before touching code.**

**Goal:** Three read-only reporting endpoints (Sales Summary, Receivables Summary/Aging, Gift Summary) in the `stationery_sales` plugin, built entirely from existing models via plain Django ORM aggregation.

**Architecture:** Three new `APIView` classes in `stationery_sales/api.py`, three new routes in `stationery_sales/plugin.py`, same house style as every existing endpoint in this plugin (hand-rolled `Response` dicts, no `serializers.py`, `IsAuthenticated`, deferred-import `csrf_exempt` URL wrapper). No new models. No migration.

**Global date-semantics rule (documented once, applies everywhere below):** each report uses exactly one date field for its `date_from`/`date_to` filter, and it is always the date the underlying business event happened — never a derived/secondary date. Aging is always computed **as of today**, independent of any date filter, because aging answers "how overdue is this *right now*," not "how overdue was this within the filtered window." This is called out per-endpoint below so no report silently mixes two date meanings.

---

## Common conventions (all three endpoints)

- **Query params:** `date_from` (optional, ISO `YYYY-MM-DD`, inclusive), `date_to` (optional, ISO `YYYY-MM-DD`, inclusive). Omitting both returns all-time data. Invalid date strings → `400 {"detail": "Invalid date_from"/"Invalid date_to"}`. `date_from > date_to` → `400 {"detail": "date_from must not be after date_to"}`.
- **Permissions:** `permission_classes = [IsAuthenticated]` — identical to every existing endpoint in this plugin. No new permission tier introduced (matches "do not weaken permissions" — these are read-only aggregates, same trust level as `CustomerReceivablesView` already has).
- **Method:** `GET` only.
- **Response shape:** every response includes an echoed `"date_from"`/`"date_to"` (the resolved filter actually applied, `null` if not provided) so a client never has to guess what window a number represents.
- **No pagination, no generic report-type dispatch** — three fixed, distinct views (per approved scope).
- **Monetary values serialized as strings** (matches existing convention throughout this plugin — `str(decimal_value)` — avoids float-precision issues in JSON).

---

## Endpoint 1: Sales Summary

`GET /plugin/stationerysales/reports/sales/`

**Date semantics:** filters on `SaleTypeMovement.created_at` (the movement/sale event date) — the only date a movement has. **Not** invoice date, **not** payment date.

**Scope:** only `sale_type in (b2b_credit, b2c_cash, b2c_online)`. `gift`/`restock`/`correction` are always excluded — they are never "sales" by definition (gift has its own report; restock/correction are inventory adjustments, not revenue events).

**Transaction value vs collected value — the distinction the brief asked to make explicit:**
- **`transaction_value`** = `sum(SaleTypeMovement.total_value)` for movements in scope+range. This is the *booked* sale value at the moment of sale, for all three types uniformly — what was sold, regardless of whether it's been paid yet.
- **`collected_value`** = how much of that has actually been paid, **as of now** (not date-filtered separately — payment collection status is always "current state," matching how `Invoice.outstanding`/`amount_paid` already work elsewhere in this plugin):
  - For `b2c_cash`/`b2c_online` movements: **equal to `transaction_value`** — these sale types have no `Invoice`/`Payment` machinery at all (only `b2b_credit` ever creates an `Invoice`), so by construction they are paid at the point of sale. Documenting this explicitly rather than leaving it implicit.
  - For `b2b_credit` movements: `sum(Invoice.amount_paid)` across the distinct invoices whose `InvoiceLineItem.sale_type_movement` falls in this filtered set of movements. (One invoice per B2B movement today — `InvoiceLineItem.sale_type_movement` is a `OneToOneField` — so this is a direct join, no fan-out risk.)

**Response structure:**
```json
{
  "date_from": "2026-01-01",
  "date_to": "2026-09-20",
  "totals": {
    "transaction_count": 142,
    "total_quantity": "3850.00000",
    "transaction_value": "192500.00000",
    "collected_value": "171200.00000"
  },
  "by_sale_type": {
    "b2b_credit": {
      "transaction_count": 30,
      "total_quantity": "900.00000",
      "transaction_value": "45000.00000",
      "collected_value": "23700.00000"
    },
    "b2c_cash": {
      "transaction_count": 80,
      "total_quantity": "2000.00000",
      "transaction_value": "97500.00000",
      "collected_value": "97500.00000"
    },
    "b2c_online": {
      "transaction_count": 32,
      "total_quantity": "950.00000",
      "transaction_value": "50000.00000",
      "collected_value": "50000.00000"
    }
  }
}
```

**Query approach:** one `SaleTypeMovement.objects.filter(sale_type__in=SALES_TYPES, created_at__date__gte=date_from, created_at__date__lte=date_to)` queryset, `.values('sale_type').annotate(count=Count('id'), qty=Sum('quantity'), value=Sum('total_value'))` for the per-type breakdown, plus a separate aggregate for the `b2b_credit` subset's linked invoices (`Invoice.objects.filter(lines__sale_type_movement__in=<b2b queryset>).distinct().aggregate(paid=Sum(...))` — actually simplest as a Python-level sum over `.annotate()`'d `amount_paid`-equivalent, since `amount_paid` is a Python property, not a DB expression; will aggregate with `Sum('payments__amount')` at the DB level directly instead of looping properties, documented in Task 2 below to keep this consistent with `outstanding`'s "don't store, compute" rule while staying efficient).

## Endpoint 2: Receivables Summary

`GET /plugin/stationerysales/reports/receivables/`

**Date semantics:** filters on `Invoice.invoice_date` (which invoices are *included* in this report). Aging buckets and all aging-bucket totals are always computed **as of today**, using `due_date`, regardless of the `date_from`/`date_to` filter — the filter narrows *which invoices count*, it does not change *when "now" is*. This dual-date-field usage (one field for inclusion, one for aging) is exactly the kind of mixing the brief said must be documented, not left implicit — documented here.

**Scope:** `Invoice.objects.exclude(status=Invoice.Status.CANCELLED)`, then `invoice_date` range filter if provided.

**Outstanding computed live, never stored** — `invoice.total - sum(valid payments)`, same as the existing `Invoice.outstanding` property; the report-level aggregate uses the DB-level equivalent (`Sum('total') - Sum('payments__amount')` style annotation, or a per-invoice loop over the existing property for correctness-first simplicity — decided at implementation time based on invoice volume, documented as a Task 2 decision point, not re-litigating the "don't store aggregates" rule either way).

**Response structure:**
```json
{
  "date_from": null,
  "date_to": null,
  "totals": {
    "total_invoiced": "875000.00000",
    "total_collected": "612000.00000",
    "total_outstanding": "263000.00000",
    "invoice_count": {
      "unpaid": 12,
      "partially_paid": 7,
      "paid": 41
    }
  },
  "aging": {
    "current": {"invoice_count": 5, "outstanding": "40000.00000"},
    "1-30": {"invoice_count": 3, "outstanding": "18000.00000"},
    "31-60": {"invoice_count": 2, "outstanding": "9000.00000"},
    "61-90": {"invoice_count": 1, "outstanding": "5000.00000"},
    "90+": {"invoice_count": 1, "outstanding": "191000.00000"}
  },
  "by_customer": [
    {"customer_id": 17, "customer_name": "Acme Stationers", "outstanding": "200000.00000"},
    {"customer_id": 22, "customer_name": "Beta Traders", "outstanding": "63000.00000"}
  ]
}
```

`by_customer` includes only customers with `outstanding > 0` (matches `CustomerReceivablesView`'s existing "only what's actually receivable" convention), sorted descending by outstanding. `invoice_count` in `totals` intentionally omits `cancelled` (already excluded from the whole report scope) — three keys only, matching the brief's exact ask ("unpaid invoice count, partially-paid invoice count, paid invoice count").

## Endpoint 3: Gift Summary

`GET /plugin/stationerysales/reports/gifts/`

**Date semantics:** filters on `SaleTypeMovement.created_at` — gifts have no invoice/payment date to borrow, so this is the only sensible choice, and it's consistent with Sales Summary's use of the same field.

**Scope:** `SaleTypeMovement.objects.filter(sale_type=SaleTypeMovement.SaleType.GIFT)`, date-ranged.

**Valuation source:** the existing immutable `unit_value`/`total_value` snapshot on each movement — never re-derived from current `Part`/`StockItem` pricing (matches the Gift Workflow plan's already-established rule; this report just aggregates what's already stored).

**Response structure:**
```json
{
  "date_from": "2026-01-01",
  "date_to": "2026-09-20",
  "totals": {
    "gift_count": 18,
    "total_quantity": "54.00000",
    "total_value": "2340.00000"
  },
  "by_part": [
    {"part_id": 34, "part_name": "Notebook A5", "quantity": "20.00000", "value": "1000.00000"},
    {"part_id": 41, "part_name": "Gel Pen", "quantity": "34.00000", "value": "1340.00000"}
  ]
}
```

`by_part` sorted descending by `value`. This is a clean, direct `.values('part').annotate(...)` group-by — no ambiguity, no cross-model join needed (unlike Sales Summary's B2B-collected-value calculation).

---

## Query/Aggregation Approach (all three)

Plain Django ORM: `.filter()`, `.values().annotate()` for group-bys, `Sum`/`Count` from `django.db.models`. No raw SQL, no materialized views, no caching layer, no new report tables — matches the explicit constraint. Each endpoint is O(1) queries per logical grouping (1–3 queries total per endpoint), acceptable for a plugin operating at this data scale; revisit only if a real performance problem is observed later (not speculatively optimized now).

## Permissions

`IsAuthenticated` on all three — identical to every other endpoint in this plugin. Not staff-restricted, since no existing endpoint in this plugin is staff-restricted either (consistency over inventing a new tier).

## Migration Requirements

**None.** Confirmed in the Part 1 audit above — every field these reports need already exists. No `makemigrations` step in this plan.

## Test Matrix (live smoke test — same `manage.py test` limitation as every prior phase applies)

**Sales Summary**
1. Correct `transaction_count`/`total_quantity`/`transaction_value` per sale type for a known fixture set.
2. `gift`/`restock`/`correction` movements never appear in totals or `by_sale_type`.
3. `collected_value == transaction_value` for `b2c_cash`/`b2c_online`.
4. `collected_value < transaction_value` for a `b2b_credit` movement with only a partial payment recorded.
5. `date_from`/`date_to` correctly excludes movements outside the window.
6. No date params → all-time totals.
7. Invalid date string → 400.
8. Unauthenticated request → 401.

**Receivables Summary**
9. `total_invoiced`/`total_collected`/`total_outstanding` correct for a known fixture set of invoices+payments.
10. Cancelled invoices excluded from every total and from aging.
11. `invoice_count` buckets (`unpaid`/`partially_paid`/`paid`) match actual invoice statuses.
12. Aging buckets match `Invoice.aging_bucket` per-invoice values, for invoices with `due_date` manually set into each of the 5 ranges.
13. Aging is unaffected by `date_from`/`date_to` (a filtered-out-by-date invoice's aging never appears, but an included invoice's aging bucket is always "as of today," not "as of the filter window").
14. `by_customer` includes only customers with `outstanding > 0`, sorted descending.
15. `date_from`/`date_to` filters by `invoice_date` correctly.
16. Unauthenticated request → 401.

**Gift Summary**
17. `gift_count`/`total_quantity`/`total_value` correct for a known fixture set.
18. Non-gift movements never included.
19. `by_part` breakdown correct and sorted descending by value.
20. `date_from`/`date_to` correctly filters by movement date.
21. Value reflects the movement's stored `unit_value`/`total_value`, not any current `Part` price (verified by changing nothing on Part and confirming the report is unaffected by that — i.e. there is no code path that reads current Part pricing at all).
22. Unauthenticated request → 401.

All disposable `SMOKETEST-` fixtures cleaned up afterward, per the established pattern (including the known `delete_owner` core-signal workaround for Company deletion if needed).

## Self-Review

- Every metric named in the brief for all three reports is accounted for above (transaction count, total quantity, total value, breakdown by type, date filtering, transaction-vs-collected distinction, total invoiced/paid/outstanding, 3 invoice-status counts, customer-level outstanding, 5 aging buckets using due date, cancelled exclusion, gift count/quantity/value, part breakdown, immutable valuation).
- Date semantics explicitly documented per endpoint, including the one genuinely mixed case (Receivables: `invoice_date` for inclusion, `due_date` for aging) called out rather than glossed over.
- No new models/migrations/caching/generic report builder — matches every constraint.
- Three separate endpoints, no `report_type` param — matches approved architecture.

## Execution Handoff

This plan is **not yet approved for implementation** per the instruction to stop after writing it. Once reviewed: recommend Subagent-Driven or Inline execution, same as prior phases, three tasks (one per endpoint) plus a final regression/smoke task.
