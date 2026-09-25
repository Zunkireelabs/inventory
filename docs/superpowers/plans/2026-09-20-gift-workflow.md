# Gift / Complimentary Stock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the gift/complimentary sale-type path enforce that a monetary valuation is always recorded, and confirm (via audit) that nothing else needs to change.

**Architecture:** No new model, no migration, no new endpoint. `gift` already flows through the exact same `record-sale/` → `services.record_sale_movement()` → `SaleTypeMovement` path as every other sale type, and that path already never touches `Invoice`/`InvoiceLineItem`/`Payment` (those are only created by the separate `record-b2b-sale/` view). The only gap: `unit_value` is currently optional (defaults to `0`) for every sale type, including `gift` — for a gift, a `0` valuation defeats the stated business requirement ("preserve a monetary valuation for reporting"). Fix: make `unit_value` required and `> 0` specifically when `sale_type == gift`, mirroring the existing per-type conditional validation already used for `customer_id` on `b2b_credit`.

**Tech Stack:** Same as existing plugin (Django, DRF `APIView`).

**Spec:** User-provided Gift/Complimentary Stock brief (2026-09-20 conversation), building on the approved Sale-Type Foundation + B2B Receivables audit/plan.

## Audit Findings (Phase 1 — completed before any code change)

1. **How `record-sale` currently handles `gift`:** `gift` is one of `OUTBOUND_TYPES` in `services.py` — it reduces stock via `stock_item.take_stock()`, creates a `StockItemTracking` entry (`StockHistoryCode.STOCK_REMOVE`), and creates a `SaleTypeMovement` row with `sale_type='gift'`, `customer=None` (customer is only ever set for `b2b_credit` — `api.py`'s `RecordSaleView.post()` only populates `customer` inside the `if sale_type == SaleTypeMovement.SaleType.B2B_CREDIT:` branch). No `Invoice`/`Payment` code path is reachable from `RecordSaleView` at all — those only exist in `RecordB2BSaleView`. **Gift already creates no invoice, no payment, no receivable — confirmed structurally, not just by omission.**

2. **How `unit_value`/`total_value` are currently calculated:** Both are caller-supplied at call time — `unit_value = Decimal(str(data.get('unit_value', 0)))`, `total_value = unit_value * quantity` (computed once, inside `record_sale_movement()`, at creation time). Stored immutably (`SaleTypeMovement` has no `save()` override, no `updated_at`, `created_at` is `auto_now_add`). This is identical for every sale type — there is no per-type special-casing of valuation today.

3. **What value exists on StockItem/Part usable for gift valuation:** `StockItem.purchase_price` (`stock/models.py:1342`, `InvenTreeModelMoneyField`, nullable, "single unit purchase price at time of purchase" — only populated when a stock item was received against a PO; `None` for manually-created stock, e.g. every `StockItem.objects.create()` in our own test fixtures). `Part.pricing` → `PartPricing` (`part/models.py:2193`, `part/models.py:2606` — a *cached*, periodically-recomputed aggregate of min/max pricing across suppliers/BOM, explicitly not a single point-in-time deterministic number). `PartSellPriceBreak` (`part/models.py` — quantity-tiered sale pricing, requires picking a quantity break, another source entirely).

4. **Does InvenTree have one canonical stock-cost/value field?** No — three competing, non-equivalent candidates exist (see #3), none of which is guaranteed non-null or point-in-time-reproducible for an arbitrary stock item. Coupling gift valuation to any of them would (a) break consistency with how every other sale type already values itself (caller-supplied at call time), (b) silently produce `None`/zero valuations for a large share of real stock items, (c) make the recorded value depend on live core-pricing state rather than a snapshot — violating "not depend on future product-price changes." **Conclusion: do not adopt any of these. Reuse the existing caller-supplied `unit_value` convention.**

5. **Does the current gift implementation already satisfy the business requirement?** Mostly yes — reduces inventory ✓, creates `SaleTypeMovement` ✓, `sale_type=gift` ✓, no invoice ✓, no payment ✓, no receivable ✓. The one gap: valuation is optional and silently defaults to `0`, which doesn't "preserve a monetary valuation" in any meaningful sense for reporting.

6. **Is a new model necessary?** No. `SaleTypeMovement` already has `unit_value`/`total_value`; nothing about a gift needs data that model can't represent.

7. **Can the existing API safely support gifts without creating an invoice?** Yes — already does, confirmed in #1. No separate gift endpoint is justified; `record-sale/` already models this cleanly and adding a second endpoint would duplicate validation/transaction logic for zero functional gain.

8. **What reporting data will be available later?** `SaleTypeMovement.sale_type` distinguishes all six types unambiguously (`TextChoices`, DB-level `CharField(choices=...)`, no free text). `unit_value`/`total_value` give per-movement monetary data for every type including gift. `part`, `created_by`, `created_at`, `customer` (null for non-B2B), `notes` round out the reportable fields. Nothing about this task's requirements is unrecoverable from the existing schema.

## Valuation Rule (decided)

**Gift value = caller-supplied `unit_value` at the time of the call, required to be present and `> 0` when `sale_type == 'gift'`.** Stored immutably in `SaleTypeMovement.unit_value`/`total_value` exactly as every other sale type already does. Reproducible (it's whatever was entered, recorded permanently), point-in-time (never re-derived), independent of future price changes (no live lookup), and consistent with the rest of the sale-type dimension (no special-cased valuation source for one type only).

## Data Model Decision

No new model, no new migration. `SaleTypeMovement` is sufficient as-is (confirmed in audit #6).

## API Decision

No new endpoint. `POST /plugin/stationerysales/record-sale/` already handles `gift` correctly except for the missing required-value check (confirmed in audit #7).

## Transaction Boundary

Unchanged — already atomic via the existing `with transaction.atomic():` block in `RecordSaleView.post()` calling `services.record_sale_movement()`. The new validation (gift requires `unit_value > 0`) happens *before* the atomic block opens, alongside the existing quantity/stock-item/customer checks — consistent with how every other pre-condition is validated in this view today.

## Validation (the only code change)

In `stationery_sales/api.py`, `RecordSaleView.post()`, immediately after the existing `unit_value` parsing block, add:

```python
if sale_type == SaleTypeMovement.SaleType.GIFT and unit_value <= 0:
    return Response(
        {'detail': 'unit_value is required and must be greater than zero for gift movements'},
        status=status.HTTP_400_BAD_REQUEST,
    )
```

This single conditional covers both "missing" (defaults to `0` already) and "explicitly zero/negative" — `unit_value` can't be negative anyway since `Decimal(str(...))` doesn't reject negative strings but nothing currently blocks a negative `unit_value` for ANY sale type today; this new check incidentally also blocks negative gift values as a side effect of `<= 0`, which is strictly correct behavior and not scope creep since it's the same line.

All other validation (invalid stock item, zero/negative quantity, quantity > available stock, invalid sale_type, authentication) already exists, unchanged, and already applies uniformly to `gift` today.

## Testing Strategy

Same limitation as before: `manage.py test` can't discover the dynamically-registered plugin app against this Supabase setup (confirmed twice already in the B2B Receivables work). Use a live smoke-test script against the real dev DB with `SMOKETEST-` prefixed disposable data, cleaned up afterward — same pattern as the B2B Receivables smoke matrix.

Matrix (maps to the 18 items in the brief):
1. Gift succeeds with valid stock + valid unit_value.
2. Stock decreases correctly.
3. `SaleTypeMovement` created with `sale_type='gift'`.
4. Correct quantity recorded.
5. Correct valuation recorded (`unit_value`/`total_value` match input).
6. No `Invoice` row created (`Invoice.objects.count()` unchanged).
7. No `Payment` row created (`Payment.objects.count()` unchanged).
8. No receivable — customer receivables endpoint unaffected (gift has no customer link at all).
9. Insufficient stock rejected.
10. Zero quantity rejected.
11. Negative quantity rejected.
12. Invalid stock item rejected.
13. Zero/missing `unit_value` for gift rejected (new check).
14. Atomic rollback on failure (insufficient stock → no stray movement).
15. Existing B2B flow still works (`record-b2b-sale/` unaffected — different view).
16. Existing B2C flow still works (`b2c_cash`/`b2c_online` unaffected — `unit_value` stays optional for these, only `gift` gets the new requirement).
17. Existing restock/correction flow still works (`unit_value` stays optional for these too).
18. Existing invalid-sale-type behavior still works.

## Migration Requirements

**None.** No model or field changes — explicitly confirmed, no `makemigrations` needed for this task.

## Self-Review

- No stop condition was hit: valuation is not ambiguous (existing caller-supplied convention, made required), no competing core field was adopted (deliberately rejected all three), no existing model solves this differently, no core InvenTree change needed, no migration at all (let alone destructive), `SaleTypeMovement` is sufficient.
- Scope check: the one-line validation touches only `gift`; `b2c_cash`/`b2c_online`/`restock`/`correction` behavior is byte-for-byte unchanged.
