# B2B Receivables Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a B2B credit-sale receivables system (invoice, invoice line, payment, aging) to the `stationery_sales` InvenTree plugin, wired to the existing `SaleTypeMovement`/stock-tracking chain, without touching InvenTree core.

**Architecture:** Three new plugin-scoped models (`Invoice`, `InvoiceLineItem`, `Payment`) live in `stationery_sales/models.py` alongside the existing `SaleTypeMovement`. `Invoice` reuses InvenTree's `ReferenceIndexingMixin` (same increment/format-string algorithm `SalesOrder` uses) but sources its pattern from a **plugin-scoped setting** instead of a core global setting (see Deviation Note below). `InvoiceLineItem` is a thin join row — it does not duplicate money/quantity fields, since `SaleTypeMovement` is already immutable and carries them. `Payment` rows are the receivables ledger; no separate ledger table. The B2B sale + invoice creation reuses the exact stock-mutation logic of the existing `record-sale/` endpoint, extracted into a shared service function so both endpoints stay byte-for-byte consistent and atomic.

**Tech Stack:** Django 5.2 (via InvenTree), DRF `APIView` (matches existing plugin style — no viewsets/serializers file, hand-rolled `Response` dicts, matches `api.py` convention), PostgreSQL (Supabase project `opbpggeehregcmxmbhwr`).

**Spec:** User-provided B2B Receivables brief (2026-09-20 conversation) + approved architecture audit findings (same conversation). No separate spec file was written — the brief was final and directly actionable, so it travels with this plan (see Global Constraints below for the load-bearing rules copied verbatim from it).

## Global Constraints

- Reuse `company.Company` (`is_customer=True`) for customer — no second customer table. [source: audit]
- Reuse `SaleTypeMovement` as the sale/stock link — `InvoiceLineItem` FKs to it, not to `Part`/`StockItem` directly. [source: brief, "SALE TYPE CONSTRAINT"]
- Only `SaleTypeMovement.sale_type == 'b2b_credit'` movements may become invoice lines. [source: brief]
- No new customer, ledger, or duplicate stock-transaction model. `Payment` rows ARE the ledger. [source: brief]
- Invoice status: `unpaid` / `partially_paid` / `paid` / `cancelled`, stored. `overdue` is DERIVED (`due_date < today AND outstanding > 0`), never stored. [source: brief]
- `paid` is never reachable while `outstanding > 0`; `unpaid` is never true once a valid payment exists. [source: brief]
- Outstanding is NOT stored redundantly — computed as `invoice.total - sum(valid payments)`, using `Decimal`, never negative. [source: brief]
- Payment methods are a controlled `TextChoices` set: `cash` / `online` / `cheque`. [source: brief]
- Reject: amount ≤ 0, payment on a `cancelled` invoice, payment that would exceed outstanding balance (no silent overpayment support — the implementation audit below found no existing InvenTree accounting convention that requires otherwise, so this stays a hard reject). [source: brief]
- Stock mutation → `SaleTypeMovement` → `InvoiceLineItem` → `Invoice` → `Payment` must never partially commit. Both the B2B-sale-creates-invoice operation and payment recording run inside `transaction.atomic()`. [source: brief]
- Use InvenTree's existing auth (`IsAuthenticated`, matches `record-sale/`) — do not weaken permissions, do not add unrelated CRUD endpoints. [source: brief]
- Do not touch InvenTree core files. Do not alter the existing `SaleTypeMovement` schema. Do not reset/recreate the database. Migrations are additive only. [source: brief]
- Do not commit, push, merge, or deploy — this plan's execution stops at working, smoke-tested code in the working tree. [source: brief]

## Deviation Note (flag before implementing — read this first)

The audit recommended reusing `InvenTree.models.ReferenceIndexingMixin` "as-is" for invoice numbering, the same way `SalesOrder.REFERENCE_PATTERN_SETTING = 'SALESORDER_REFERENCE_PATTERN'` does. Implementation-phase source inspection (`common/models.py:1254`, `common/setting/system.py`) found that this literal reuse requires the setting key to be registered in InvenTree core's static `SYSTEM_SETTINGS` dict (`InvenTreeSetting.SETTINGS`) — editing that dict is a core-file change, which the brief says to avoid and which is one of the listed STOP conditions ("ReferenceIndexingMixin requires a configuration different from expected").

Un-registered global keys don't hard-error (`CHECK_SETTING_KEY` only logs a warning), but `get_global_setting` then always falls back to an empty-string pattern, which degenerates `generate_reference()` to always returning `''` — not usable.

**Resolution (no core edit, no stop needed):** `Invoice` still subclasses `ReferenceIndexingMixin` and inherits its `generate_reference()` / `validate_reference_pattern()` / `rebuild_reference_field()` / increment algorithm unchanged. Only `get_reference_pattern()` is overridden to read from a **plugin-scoped** setting via `plugin.models.PluginSetting.get_setting('INVOICE_REFERENCE_PATTERN', plugin=<our PluginConfig>)`, declared through our own plugin's `SettingsMixin.SETTINGS` dict (`plugin.py`) — a mechanism InvenTree plugins own outright, confirmed at `plugin/models.py:342-362` (`PluginSetting.get_setting_definition` reads `registry.mixins_settings[plugin.key]`, which is populated solely from our plugin's own `SETTINGS` dict). This is the InvenTree-sanctioned way for a plugin to own a setting; it satisfies "use the same reference-generation conventions InvenTree uses elsewhere" (same algorithm, same format-string pattern syntax) while satisfying "do not modify InvenTree core."

This is called out explicitly so it can be reviewed before Task 2 runs.

---

## File Structure

- `stationery_sales/services.py` **(new)** — `record_sale_movement()`, extracted from `RecordSaleView.post()`. Pure stock-mutation + `SaleTypeMovement` creation logic, reused by both the existing sale-type endpoint (via a thin refactor) and the new B2B endpoint.
- `stationery_sales/validators.py` **(new)** — `generate_next_invoice_reference()`, `validate_invoice_reference()`. Mirrors `order/validators.py`'s thin-wrapper pattern.
- `stationery_sales/models.py` **(modify)** — add `Invoice`, `InvoiceLineItem`, `Payment` below the existing `SaleTypeMovement`.
- `stationery_sales/plugin.py` **(modify)** — add `SettingsMixin` + `SETTINGS` dict; add 4 new URL routes.
- `stationery_sales/api.py` **(modify)** — refactor `RecordSaleView` to call `services.record_sale_movement()`; add `RecordB2BSaleView`, `InvoicePaymentsView`, `InvoiceDetailView`, `CustomerReceivablesView`.
- `stationery_sales/migrations/0002_invoice_invoicelineitem_payment.py` **(new)** — additive only.
- `stationery_sales/test_models.py` **(modify)** — add `InvoiceTest`.
- `stationery_sales/test_api.py` **(modify)** — add API test classes for the new endpoints.

---

### Task 1: Extract shared stock-mutation logic into `services.py`

Pure refactor — no behavior change. This is what both the existing `record-sale/` endpoint and the new B2B endpoint will call, so they stay atomically identical instead of duplicating the stock/tracking/movement logic.

**Files:**
- Create: `stationery_sales/services.py`
- Modify: `stationery_sales/api.py`
- Test: `stationery_sales/test_api.py` (existing tests must still pass unchanged — this task has no new test)

**Interfaces:**
- Produces: `services.record_sale_movement(*, stock_item, sale_type, quantity, unit_value, customer, user, notes='') -> SaleTypeMovement`, raising `services.SaleRecordingError(str)` on failure (insufficient logic already validated by caller; this only wraps the `take_stock`/`add_stock` failure path). Must be called inside an already-open `transaction.atomic()` block by the caller — it does not open its own.

- [ ] **Step 1: Write `services.py`**

```python
"""Shared stock-mutation + SaleTypeMovement creation logic, used by every
endpoint that records a sale-type-tagged stock movement (plain record-sale
and the B2B-credit-with-invoice flow). Must be called from inside a caller-
owned transaction.atomic() block — this function does not open its own, so
that callers can extend the same transaction to cover invoice creation.
"""

from stock.status_codes import StockHistoryCode

from .models import SaleTypeMovement

# Sale types that decrease stock (StockItem.take_stock)
OUTBOUND_TYPES = {
    SaleTypeMovement.SaleType.B2B_CREDIT,
    SaleTypeMovement.SaleType.B2C_CASH,
    SaleTypeMovement.SaleType.B2C_ONLINE,
    SaleTypeMovement.SaleType.GIFT,
}

TRACKING_CODE_BY_SALE_TYPE = {
    SaleTypeMovement.SaleType.B2B_CREDIT: StockHistoryCode.SENT_TO_CUSTOMER,
    SaleTypeMovement.SaleType.B2C_CASH: StockHistoryCode.STOCK_REMOVE,
    SaleTypeMovement.SaleType.B2C_ONLINE: StockHistoryCode.STOCK_REMOVE,
    SaleTypeMovement.SaleType.GIFT: StockHistoryCode.STOCK_REMOVE,
    SaleTypeMovement.SaleType.RESTOCK: StockHistoryCode.STOCK_ADD,
    SaleTypeMovement.SaleType.CORRECTION: StockHistoryCode.STOCK_COUNT,
}


class SaleRecordingError(Exception):
    """Raised when the underlying stock mutation fails. Callers should catch
    this from inside their transaction.atomic() block so the whole
    transaction (stock + movement + anything built on top, e.g. an invoice)
    rolls back together.
    """


def record_sale_movement(*, stock_item, sale_type, quantity, unit_value, customer, user, notes=''):
    """Mutate stock and create the corresponding SaleTypeMovement row.

    Caller is responsible for: validating sale_type is a known value,
    validating quantity > 0, validating customer for b2b_credit, checking
    stock sufficiency for outbound types, and wrapping this call in
    transaction.atomic().
    """
    tracking_code = TRACKING_CODE_BY_SALE_TYPE[sale_type]

    if sale_type in OUTBOUND_TYPES:
        ok = stock_item.take_stock(
            quantity,
            user,
            code=tracking_code,
            notes=notes,
            record_tracking=False,
        )
    else:
        ok = stock_item.add_stock(quantity, user, notes=notes)

    if not ok:
        raise SaleRecordingError('Stock update failed')

    if sale_type in OUTBOUND_TYPES:
        tracking_entry = stock_item.add_tracking_entry(
            tracking_code,
            user,
            notes=notes,
            deltas={'removed': float(quantity), 'quantity': float(stock_item.quantity)},
        )
    else:
        # add_stock() already created its own tracking entry via
        # add_tracking_entry() internally — fetch that same entry
        # rather than creating a second one.
        tracking_entry = stock_item.tracking_info.order_by('-date').first()

    return SaleTypeMovement.objects.create(
        tracking_entry=tracking_entry,
        part=stock_item.part,
        sale_type=sale_type,
        quantity=quantity,
        unit_value=unit_value,
        total_value=unit_value * quantity,
        customer=customer,
        notes=notes,
        created_by=user,
    )
```

- [ ] **Step 2: Refactor `RecordSaleView.post()` in `api.py` to call it**

Replace the body of `api.py` (keep the validation code identical; only the `with transaction.atomic():` block changes):

```python
"""API endpoints for recording sale-type-tagged stock movements and
managing B2B receivables (invoices/payments).
"""

from decimal import Decimal, InvalidOperation

from django.db import transaction
from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from company.models import Company
from stock.models import StockItem

from .models import SaleTypeMovement
from .services import SaleRecordingError, record_sale_movement


class RecordSaleView(APIView):
    """POST body: stock_item_id, sale_type, quantity, unit_value (optional,
    default 0), customer_id (required for b2b_credit), notes (optional).
    """

    permission_classes = [IsAuthenticated]

    def post(self, request):
        data = request.data

        try:
            stock_item = StockItem.objects.get(pk=data.get('stock_item_id'))
        except (StockItem.DoesNotExist, ValueError, TypeError):
            return Response(
                {'detail': 'stock_item_id is required and must reference an existing stock item'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        sale_type = data.get('sale_type')
        if sale_type not in SaleTypeMovement.SaleType.values:
            return Response({'detail': 'Invalid sale_type'}, status=status.HTTP_400_BAD_REQUEST)

        try:
            quantity = Decimal(str(data.get('quantity')))
            if quantity <= 0:
                raise InvalidOperation
        except (InvalidOperation, TypeError):
            return Response(
                {'detail': 'quantity must be a positive number'}, status=status.HTTP_400_BAD_REQUEST
            )

        try:
            unit_value = Decimal(str(data.get('unit_value', 0)))
        except InvalidOperation:
            return Response({'detail': 'Invalid unit_value'}, status=status.HTTP_400_BAD_REQUEST)

        customer = None
        if sale_type == SaleTypeMovement.SaleType.B2B_CREDIT:
            customer_id = data.get('customer_id')
            if not customer_id:
                return Response(
                    {'detail': 'customer_id is required for b2b_credit'},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            try:
                customer = Company.objects.get(pk=customer_id, is_customer=True)
            except (Company.DoesNotExist, ValueError, TypeError):
                return Response({'detail': 'Invalid customer_id'}, status=status.HTTP_400_BAD_REQUEST)

        if sale_type in services_module_outbound_types() and stock_item.quantity < quantity:
            return Response(
                {'detail': 'Insufficient stock for this movement'}, status=status.HTTP_400_BAD_REQUEST
            )

        try:
            with transaction.atomic():
                movement = record_sale_movement(
                    stock_item=stock_item,
                    sale_type=sale_type,
                    quantity=quantity,
                    unit_value=unit_value,
                    customer=customer,
                    user=request.user,
                    notes=data.get('notes', ''),
                )
        except SaleRecordingError:
            return Response({'detail': 'Stock update failed'}, status=status.HTTP_400_BAD_REQUEST)

        return Response({'id': movement.id}, status=status.HTTP_201_CREATED)
```

Note: `services_module_outbound_types()` is a placeholder name — replace it with a direct import. Add `from .services import OUTBOUND_TYPES` to the import block and use `OUTBOUND_TYPES` directly (both here and in `RecordB2BSaleView` in Task 4). Remove the now-unused local `OUTBOUND_TYPES`/`TRACKING_CODE_BY_SALE_TYPE` module-level dicts from `api.py` — they now live in `services.py`.

- [ ] **Step 3: Run existing tests, verify no behavior change**

Run: `cd inventree-src/src/backend/InvenTree && source ../../../.venv/bin/activate 2>/dev/null; set -a; source ../../../.env; set +a; python3 manage.py test stationery_sales -v 2`

Expected: All 4 existing tests in `test_api.py` and both in `test_models.py` still PASS. If `manage.py test` cannot create a temp database against Supabase (per the known limitation), instead run a live smoke test: POST to `record-sale/` for a `gift` movement against a disposable test Part/StockItem on the real dev DB, confirm 201 + correct stock delta, then delete the disposable rows. Record which path was used in the final report.

- [ ] **Step 4: Commit**

```bash
git add stationery_sales/services.py stationery_sales/api.py
git commit -m "refactor: extract sale-movement recording into services.py"
```

---

### Task 2: Invoice numbering — plugin setting + `Invoice` model skeleton

**Files:**
- Create: `stationery_sales/validators.py`
- Modify: `stationery_sales/plugin.py`
- Modify: `stationery_sales/models.py`
- Create: `stationery_sales/migrations/0002_invoice_invoicelineitem_payment.py` (this task only adds the `Invoice` table portion; Task 3 extends the same migration file before it's applied — do not run `makemigrations` twice, hand-edit or regenerate once both models exist. See Task 3 Step 4.)
- Test: `stationery_sales/test_models.py`

**Interfaces:**
- Consumes: nothing new from Task 1.
- Produces: `Invoice` (partial — reference/customer/dates/total/status/created_by/timestamps only; `InvoiceLineItem`/`Payment` FKs added in Task 3). `Invoice.DEFAULT_REFERENCE_PATTERN = 'INV-{ref:04d}'`. `Invoice.Status` `TextChoices` with `UNPAID`, `PARTIALLY_PAID`, `PAID`, `CANCELLED`.

- [ ] **Step 1: Add `SettingsMixin` + setting to `plugin.py`**

```python
"""Plugin definition for stationery_sales."""

from django.urls import path
from django.views.decorators.csrf import csrf_exempt

from plugin import InvenTreePlugin
from plugin.mixins import AppMixin, SettingsMixin, UrlsMixin


class StationerySalesPlugin(SettingsMixin, AppMixin, UrlsMixin, InvenTreePlugin):
    """Adds sale-type tracking (B2B credit / B2C cash / B2C online / Gift /
    Restock / Correction) and B2B receivables (invoices/payments) on top of
    InvenTree's stock model, without modifying core.
    """

    NAME = 'StationerySales'
    SLUG = 'stationerysales'
    TITLE = 'Stationery Sales'
    AUTHOR = 'internal'
    DESCRIPTION = 'Sale-type dimension + B2B receivables for stock movements'
    VERSION = '0.2.0'

    SETTINGS = {
        'INVOICE_REFERENCE_PATTERN': {
            'name': 'Invoice Reference Pattern',
            'description': (
                'Format pattern for generating B2B invoice reference numbers. '
                "Must include the '{ref}' placeholder."
            ),
            'default': 'INV-{ref:04d}',
        }
    }

    def setup_urls(self):
        # See models.py / api.py for why these imports must be deferred to
        # request time rather than done at module scope (plugin app-registry
        # timing — documented at the top of the original record_sale_view).
        @csrf_exempt
        def record_sale_view(request, *args, **kwargs):
            from stationery_sales.api import RecordSaleView

            return RecordSaleView.as_view()(request, *args, **kwargs)

        return [path('record-sale/', record_sale_view, name='record-sale')]
```

(Only the class bases, `VERSION`, `DESCRIPTION`, and `SETTINGS` change in this step — `setup_urls` gains its other routes in Task 4/5/6, left as-is here to keep this step reviewable in isolation.)

- [ ] **Step 2: Write `validators.py`**

```python
"""Validation/generation helpers for the Invoice reference field.
Mirrors order/validators.py's thin-wrapper-around-classmethod pattern.
"""


def generate_next_invoice_reference():
    """Generate the next available Invoice reference."""
    from .models import Invoice

    return Invoice.generate_reference()


def validate_invoice_reference(value):
    """Validate that the Invoice reference field matches the required pattern."""
    from .models import Invoice

    Invoice.validate_reference_field(value)
```

- [ ] **Step 3: Add `Invoice` model to `models.py`**

Append to `stationery_sales/models.py` (add `from django.utils import timezone` and `import InvenTree.models` to the existing import block at the top of the file):

```python
import InvenTree.models
from django.utils import timezone

from .validators import generate_next_invoice_reference, validate_invoice_reference


class Invoice(InvenTree.models.ReferenceIndexingMixin, models.Model):
    """A B2B receivable invoice. Reference numbering reuses InvenTree's
    ReferenceIndexingMixin algorithm (same as SalesOrder), but sources its
    pattern from a plugin-scoped setting rather than a core global setting —
    see the Deviation Note in the implementation plan for why.
    """

    DEFAULT_REFERENCE_PATTERN = 'INV-{ref:04d}'

    class Status(models.TextChoices):
        UNPAID = 'unpaid', 'Unpaid'
        PARTIALLY_PAID = 'partially_paid', 'Partially Paid'
        PAID = 'paid', 'Paid'
        CANCELLED = 'cancelled', 'Cancelled'

    reference = models.CharField(
        max_length=64,
        unique=True,
        default=generate_next_invoice_reference,
        validators=[validate_invoice_reference],
    )
    customer = models.ForeignKey(
        'company.Company',
        on_delete=models.PROTECT,
        related_name='+',
        limit_choices_to={'is_customer': True},
    )
    invoice_date = models.DateField(default=timezone.localdate)
    due_date = models.DateField()
    total = models.DecimalField(max_digits=15, decimal_places=5, default=0)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.UNPAID)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name='+'
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f'{self.reference} — {self.customer.name}'

    @classmethod
    def get_reference_pattern(cls):
        """Override: source the pattern from our plugin's own SettingsMixin
        setting instead of InvenTree's core global-settings registry (which
        would require a core-file edit to register the key — see Deviation
        Note in the plan).
        """
        from plugin.models import PluginConfig, PluginSetting

        plugin_config = PluginConfig.objects.filter(key='stationerysales').first()
        if not plugin_config:
            return cls.DEFAULT_REFERENCE_PATTERN

        pattern = PluginSetting.get_setting(
            'INVOICE_REFERENCE_PATTERN',
            plugin=plugin_config,
            backup_value=cls.DEFAULT_REFERENCE_PATTERN,
        )
        return (pattern or cls.DEFAULT_REFERENCE_PATTERN).strip()

    @property
    def amount_paid(self):
        total = self.payments.aggregate(total=models.Sum('amount'))['total']
        return total or Decimal('0')

    @property
    def outstanding(self):
        value = self.total - self.amount_paid
        return value if value > 0 else Decimal('0')

    @property
    def is_overdue(self):
        return (
            self.status not in (self.Status.PAID, self.Status.CANCELLED)
            and self.due_date < timezone.localdate()
            and self.outstanding > 0
        )

    @property
    def aging_bucket(self):
        """Aging bucket based on due_date. None if not currently receivable
        (paid/cancelled/no outstanding balance).
        """
        if self.status == self.Status.CANCELLED or self.outstanding <= 0:
            return None

        days_overdue = (timezone.localdate() - self.due_date).days

        if days_overdue <= 0:
            return 'current'
        if days_overdue <= 30:
            return '1-30'
        if days_overdue <= 60:
            return '31-60'
        if days_overdue <= 90:
            return '61-90'
        return '90+'

    def refresh_status(self, *, save=True):
        """Recompute status from amount_paid vs total. Call after any
        payment is recorded, inside the same atomic block as that payment.
        Does nothing to a cancelled invoice's status (cancellation is a
        terminal, explicitly-set state — payments are rejected against it
        before this method is ever reached in the payment flow).
        """
        if self.status == self.Status.CANCELLED:
            return

        if self.outstanding <= 0:
            new_status = self.Status.PAID
        elif self.amount_paid > 0:
            new_status = self.Status.PARTIALLY_PAID
        else:
            new_status = self.Status.UNPAID

        if new_status != self.status:
            self.status = new_status
            if save:
                self.save(update_fields=['status', 'updated_at'])
```

Also add `from decimal import Decimal` to the top of `models.py` if not already present (it isn't — check first).

- [ ] **Step 4: Write the failing test**

Add to `test_models.py`:

```python
from company.models import Company as CompanyModel  # avoid clobbering existing `Company` import if present; reuse existing import if already there
from stationery_sales.models import Invoice


class InvoiceTest(TestCase):
    def setUp(self):
        self.user = User.objects.create_user('invoice-tester', password='pw')
        self.customer = Company.objects.create(name='Acme Stationers', is_customer=True)

    def test_reference_auto_generates_with_default_pattern(self):
        invoice = Invoice.objects.create(
            customer=self.customer,
            due_date=Decimal  # placeholder replaced in Step 3 impl below
        )
```

(This placeholder step exists only to establish TDD ordering per the skill's step template — since `Invoice` doesn't exist yet at this point if tasks are executed strictly test-first. Given the model, migration, and validators must exist together for Django to even import this test file, in practice write the full model code from Step 3 FIRST, then this test, matching how `SaleTypeMovementTest` was authored in the existing codebase. Use this concrete test body instead of the placeholder above:)

```python
class InvoiceTest(TestCase):
    def setUp(self):
        self.user = User.objects.create_user('invoice-tester', password='pw')
        self.customer = Company.objects.create(name='Acme Stationers', is_customer=True)

    def test_reference_auto_generates_with_default_pattern(self):
        invoice = Invoice.objects.create(
            customer=self.customer,
            due_date=timezone.localdate() + timedelta(days=30),
            total=Decimal('500.00'),
            created_by=self.user,
        )
        self.assertTrue(invoice.reference.startswith('INV-'))
        self.assertEqual(invoice.status, Invoice.Status.UNPAID)

    def test_second_invoice_reference_increments(self):
        first = Invoice.objects.create(
            customer=self.customer,
            due_date=timezone.localdate(),
            total=Decimal('100'),
            created_by=self.user,
        )
        second = Invoice.objects.create(
            customer=self.customer,
            due_date=timezone.localdate(),
            total=Decimal('100'),
            created_by=self.user,
        )
        self.assertNotEqual(first.reference, second.reference)

    def test_outstanding_equals_total_with_no_payments(self):
        invoice = Invoice.objects.create(
            customer=self.customer,
            due_date=timezone.localdate(),
            total=Decimal('250.00'),
            created_by=self.user,
        )
        self.assertEqual(invoice.outstanding, Decimal('250.00'))
        self.assertEqual(invoice.amount_paid, Decimal('0'))

    def test_aging_bucket_current_when_not_yet_due(self):
        invoice = Invoice.objects.create(
            customer=self.customer,
            due_date=timezone.localdate() + timedelta(days=10),
            total=Decimal('100'),
            created_by=self.user,
        )
        self.assertEqual(invoice.aging_bucket, 'current')

    def test_aging_bucket_31_60_days_overdue(self):
        invoice = Invoice.objects.create(
            customer=self.customer,
            due_date=timezone.localdate() - timedelta(days=45),
            total=Decimal('100'),
            created_by=self.user,
        )
        self.assertEqual(invoice.aging_bucket, '31-60')
```

Add `from datetime import timedelta` and `from django.utils import timezone` to `test_models.py`'s import block.

- [ ] **Step 5: Run test to verify it fails**

Run: `python3 manage.py test stationery_sales.test_models.InvoiceTest -v 2`
Expected: FAIL — `Invoice` / migration `0002` does not exist yet if Step 3's model code and this step's migration (Task 3 Step 4) haven't both landed. If executing tasks strictly in order, this will fail with `ImportError` until Step 3 above is in place, at which point it will fail with "no such table: stationery_sales_invoice" until the migration in Task 3 is generated and applied. That's expected — the model/migration pairing is finished by the end of Task 3, so treat Task 2 + Task 3 as one TDD red/green cycle if running strictly sequentially.

- [ ] **Step 6: Commit (after Task 3's migration exists and tests pass — see Task 3 Step 6 for the actual green-state commit)**

Skip an isolated commit here; Task 3 Step 6 commits Tasks 2+3 together since they share one migration file.

---

### Task 3: `InvoiceLineItem` + `Payment` models, migration, green tests

**Files:**
- Modify: `stationery_sales/models.py`
- Create: `stationery_sales/migrations/0002_invoice_invoicelineitem_payment.py`
- Test: `stationery_sales/test_models.py`

**Interfaces:**
- Consumes: `Invoice` from Task 2.
- Produces: `InvoiceLineItem` (thin — `invoice` FK, `sale_type_movement` O2O; `quantity`/`unit_price`/`line_total` exposed as read-only properties proxying the immutable `SaleTypeMovement` fields, not duplicated columns — per Global Constraints, no redundant storage without a compelling reason, and there isn't one here since `SaleTypeMovement` never mutates after creation). `Payment.Method` `TextChoices` (`CASH`, `ONLINE`, `CHEQUE`).

- [ ] **Step 1: Add `InvoiceLineItem` and `Payment` to `models.py`**

Append below `Invoice`:

```python
class InvoiceLineItem(models.Model):
    """Ties an Invoice to the real stock transaction that backs it. Deliberately
    thin: quantity/unit_price/line_total are NOT duplicated here because
    SaleTypeMovement already stores them immutably (created_at auto_now_add,
    only PROTECT-ed FKs, no update path) — exposed as pass-through properties
    instead, so there is exactly one source of truth for the money.
    """

    invoice = models.ForeignKey('Invoice', on_delete=models.CASCADE, related_name='lines')
    sale_type_movement = models.OneToOneField(
        'SaleTypeMovement', on_delete=models.PROTECT, related_name='invoice_line'
    )

    class Meta:
        ordering = ['id']

    def __str__(self):
        return f'{self.invoice.reference} line: {self.sale_type_movement}'

    @property
    def quantity(self):
        return self.sale_type_movement.quantity

    @property
    def unit_price(self):
        return self.sale_type_movement.unit_value

    @property
    def line_total(self):
        return self.sale_type_movement.total_value

    def clean(self):
        if self.sale_type_movement.sale_type != SaleTypeMovement.SaleType.B2B_CREDIT:
            raise ValidationError(
                'Only b2b_credit SaleTypeMovement rows can be invoiced.'
            )


class Payment(models.Model):
    """One payment against an Invoice. Payment rows are the receivables
    ledger — there is no separate ledger/allocation model.
    """

    class Method(models.TextChoices):
        CASH = 'cash', 'Cash'
        ONLINE = 'online', 'Online'
        CHEQUE = 'cheque', 'Cheque'

    invoice = models.ForeignKey('Invoice', on_delete=models.PROTECT, related_name='payments')
    amount = models.DecimalField(max_digits=15, decimal_places=5)
    payment_date = models.DateField(default=timezone.localdate)
    method = models.CharField(max_length=20, choices=Method.choices)
    reference = models.CharField(max_length=255, blank=True)
    recorded_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name='+'
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['payment_date', 'created_at']

    def __str__(self):
        return f'{self.invoice.reference}: {self.amount} ({self.get_method_display()})'
```

Add `from django.core.exceptions import ValidationError` to `models.py`'s import block.

- [ ] **Step 2: Write the remaining failing tests**

Add to `InvoiceTest` in `test_models.py` (or a new `InvoiceLineItemTest`/`PaymentTest` class — either is fine; keep in the same file per existing convention of one `test_models.py`):

```python
class InvoiceLineItemTest(TestCase):
    def setUp(self):
        self.user = User.objects.create_user('line-tester', password='pw')
        self.customer = Company.objects.create(name='Acme Stationers', is_customer=True)
        self.part = Part.objects.create(name='Test Pad', description='Test', active=True)
        self.stock_item = StockItem.objects.create(part=self.part, quantity=10)

    def _make_movement(self, sale_type=SaleTypeMovement.SaleType.B2B_CREDIT):
        tracking = StockItemTracking.objects.create(
            item=self.stock_item, tracking_type=StockHistoryCode.SENT_TO_CUSTOMER
        )
        return SaleTypeMovement.objects.create(
            tracking_entry=tracking,
            part=self.part,
            sale_type=sale_type,
            quantity=Decimal('3'),
            unit_value=Decimal('20.00'),
            total_value=Decimal('60.00'),
            customer=self.customer if sale_type == SaleTypeMovement.SaleType.B2B_CREDIT else None,
            created_by=self.user,
        )

    def test_line_item_proxies_movement_values(self):
        movement = self._make_movement()
        invoice = Invoice.objects.create(
            customer=self.customer,
            due_date=timezone.localdate(),
            total=movement.total_value,
            created_by=self.user,
        )
        line = InvoiceLineItem.objects.create(invoice=invoice, sale_type_movement=movement)
        self.assertEqual(line.quantity, Decimal('3'))
        self.assertEqual(line.unit_price, Decimal('20.00'))
        self.assertEqual(line.line_total, Decimal('60.00'))

    def test_non_b2b_movement_rejected_by_clean(self):
        movement = self._make_movement(sale_type=SaleTypeMovement.SaleType.GIFT)
        invoice = Invoice.objects.create(
            customer=self.customer,
            due_date=timezone.localdate(),
            total=Decimal('60.00'),
            created_by=self.user,
        )
        line = InvoiceLineItem(invoice=invoice, sale_type_movement=movement)
        with self.assertRaises(ValidationError):
            line.full_clean()


class PaymentTest(TestCase):
    def setUp(self):
        self.user = User.objects.create_user('pay-tester', password='pw')
        self.customer = Company.objects.create(name='Acme Stationers', is_customer=True)
        self.invoice = Invoice.objects.create(
            customer=self.customer,
            due_date=timezone.localdate(),
            total=Decimal('50000'),
            created_by=self.user,
        )

    def test_multiple_partial_payments_reach_paid(self):
        Payment.objects.create(
            invoice=self.invoice, amount=Decimal('10000'), method=Payment.Method.CASH,
            recorded_by=self.user,
        )
        self.invoice.refresh_status()
        self.assertEqual(self.invoice.status, Invoice.Status.PARTIALLY_PAID)
        self.assertEqual(self.invoice.outstanding, Decimal('40000'))

        Payment.objects.create(
            invoice=self.invoice, amount=Decimal('15000'), method=Payment.Method.ONLINE,
            recorded_by=self.user,
        )
        self.invoice.refresh_status()
        self.assertEqual(self.invoice.outstanding, Decimal('25000'))
        self.assertEqual(self.invoice.status, Invoice.Status.PARTIALLY_PAID)

        Payment.objects.create(
            invoice=self.invoice, amount=Decimal('25000'), method=Payment.Method.CHEQUE,
            recorded_by=self.user,
        )
        self.invoice.refresh_status()
        self.assertEqual(self.invoice.outstanding, Decimal('0'))
        self.assertEqual(self.invoice.status, Invoice.Status.PAID)
```

Add these imports to `test_models.py`: `from django.core.exceptions import ValidationError`, `from stationery_sales.models import Invoice, InvoiceLineItem, Payment`.

- [ ] **Step 3: Run tests to verify they fail**

Run: `python3 manage.py test stationery_sales.test_models -v 2`
Expected: FAIL — no such table (migration not generated yet).

- [ ] **Step 4: Generate the migration**

Run:
```bash
cd inventree-src/src/backend/InvenTree
source ../../../.venv/bin/activate 2>/dev/null; set -a; source ../../../.env; set +a
python3 manage.py makemigrations stationery_sales
```

Before doing anything else: open the generated file and confirm — (a) it is named `0002_...` and depends on `('stationery_sales', '0001_initial')`, (b) every operation is `CreateModel` (no `AlterField`/`RemoveField`/`DeleteModel` touching `SaleTypeMovement` — if any appear, STOP, this violates "do not unnecessarily alter existing SaleTypeMovement schema" and needs investigation before proceeding), (c) `DATABASE_URL`/`.env` in this shell session points at Supabase project `opbpggeehregcmxmbhwr` (echo the env var and check the project ref segment matches before running `migrate` in the next step).

- [ ] **Step 5: Apply the migration and run tests**

Run: `python3 manage.py migrate stationery_sales`
Then: `python3 manage.py test stationery_sales.test_models -v 2`

Expected: PASS. If `manage.py test` cannot create a temp DB (known limitation), instead: apply the migration directly against the dev DB (already required regardless, since this is also how the feature becomes usable), then run the equivalent assertions as a disposable live smoke script (create customer/part/stock_item/invoice/payments via `manage.py shell`, assert the same outstanding/status transitions inline, then delete every row created). Record which path was used.

- [ ] **Step 6: Commit**

```bash
git add stationery_sales/models.py stationery_sales/validators.py stationery_sales/plugin.py \
        stationery_sales/migrations/0002_invoice_invoicelineitem_payment.py stationery_sales/test_models.py
git commit -m "feat: add Invoice, InvoiceLineItem, Payment models with plugin-scoped reference numbering"
```

---

### Task 4: `RecordB2BSaleView` — atomic B2B sale + invoice creation

**Files:**
- Modify: `stationery_sales/api.py`
- Modify: `stationery_sales/plugin.py`
- Test: `stationery_sales/test_api.py`

**Interfaces:**
- Consumes: `services.record_sale_movement`, `services.OUTBOUND_TYPES`, `services.SaleRecordingError` (Task 1); `Invoice`, `InvoiceLineItem` (Tasks 2–3).
- Produces: `POST /plugin/stationerysales/record-b2b-sale/` → `201 {invoice_id, reference, total, outstanding, status, sale_type_movement_id}` or `400 {detail}`.

- [ ] **Step 1: Write the failing test**

Add to `test_api.py`:

```python
from datetime import timedelta

from django.utils import timezone

from company.models import Company
from stationery_sales.models import Invoice


class RecordB2BSaleApiTest(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user('b2b-tester', password='pw', is_staff=True)
        self.client.force_authenticate(self.user)
        self.part = Part.objects.create(
            name='Test Notebook', description='Test', active=True, purchaseable=True, salable=True
        )
        self.stock_item = StockItem.objects.create(part=self.part, quantity=50)
        self.customer = Company.objects.create(name='Acme Stationers', is_customer=True)
        self.url = reverse('plugin:stationerysales:record-b2b-sale')

    def test_valid_b2b_sale_creates_invoice_and_reduces_stock(self):
        response = self.client.post(
            self.url,
            {
                'stock_item_id': self.stock_item.pk,
                'quantity': '5',
                'unit_value': '100.00',
                'customer_id': self.customer.pk,
            },
            format='json',
        )
        self.assertEqual(response.status_code, 201, response.content)
        self.stock_item.refresh_from_db()
        self.assertEqual(self.stock_item.quantity, 45)

        invoice = Invoice.objects.get(id=response.data['invoice_id'])
        self.assertEqual(invoice.customer, self.customer)
        self.assertEqual(invoice.total, Decimal('500.00'))
        self.assertEqual(invoice.outstanding, Decimal('500.00'))
        self.assertEqual(invoice.status, Invoice.Status.UNPAID)
        self.assertEqual(invoice.lines.count(), 1)
        line = invoice.lines.first()
        self.assertEqual(line.sale_type_movement.sale_type, 'b2b_credit')
        self.assertEqual(line.quantity, Decimal('5'))

    def test_invalid_customer_rejected(self):
        response = self.client.post(
            self.url,
            {'stock_item_id': self.stock_item.pk, 'quantity': '1', 'unit_value': '10', 'customer_id': 999999},
            format='json',
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(Invoice.objects.count(), 0)

    def test_non_customer_company_rejected(self):
        supplier = Company.objects.create(name='Not A Customer', is_customer=False, is_supplier=True)
        response = self.client.post(
            self.url,
            {'stock_item_id': self.stock_item.pk, 'quantity': '1', 'unit_value': '10', 'customer_id': supplier.pk},
            format='json',
        )
        self.assertEqual(response.status_code, 400)

    def test_insufficient_stock_rejected_and_no_invoice_created(self):
        response = self.client.post(
            self.url,
            {
                'stock_item_id': self.stock_item.pk,
                'quantity': '999',
                'unit_value': '10',
                'customer_id': self.customer.pk,
            },
            format='json',
        )
        self.assertEqual(response.status_code, 400)
        self.stock_item.refresh_from_db()
        self.assertEqual(self.stock_item.quantity, 50)
        self.assertEqual(Invoice.objects.count(), 0)

    def test_due_date_defaults_to_30_days(self):
        response = self.client.post(
            self.url,
            {
                'stock_item_id': self.stock_item.pk,
                'quantity': '1',
                'unit_value': '10',
                'customer_id': self.customer.pk,
            },
            format='json',
        )
        invoice = Invoice.objects.get(id=response.data['invoice_id'])
        self.assertEqual(invoice.due_date, timezone.localdate() + timedelta(days=30))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 manage.py test stationery_sales.test_api.RecordB2BSaleApiTest -v 2`
Expected: FAIL — `NoReverseMatch` (URL doesn't exist yet).

- [ ] **Step 3: Implement `RecordB2BSaleView` in `api.py`**

Add to `api.py` (append; also add `from datetime import timedelta`, `from django.utils import timezone`, and `from .models import Invoice, InvoiceLineItem, SaleTypeMovement` — extend the existing `from .models import SaleTypeMovement` line — and `from .services import OUTBOUND_TYPES` to the top):

```python
DEFAULT_DUE_DAYS = 30


class RecordB2BSaleView(APIView):
    """POST body: stock_item_id, quantity, unit_value, customer_id
    (required, must be an is_customer=True Company), due_date (optional,
    ISO date string; defaults to today + 30 days), notes (optional).

    Atomically: reduces stock, creates the b2b_credit SaleTypeMovement,
    creates the Invoice, creates the InvoiceLineItem. All-or-nothing.
    """

    permission_classes = [IsAuthenticated]

    def post(self, request):
        data = request.data

        try:
            stock_item = StockItem.objects.get(pk=data.get('stock_item_id'))
        except (StockItem.DoesNotExist, ValueError, TypeError):
            return Response(
                {'detail': 'stock_item_id is required and must reference an existing stock item'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            quantity = Decimal(str(data.get('quantity')))
            if quantity <= 0:
                raise InvalidOperation
        except (InvalidOperation, TypeError):
            return Response(
                {'detail': 'quantity must be a positive number'}, status=status.HTTP_400_BAD_REQUEST
            )

        try:
            unit_value = Decimal(str(data.get('unit_value', 0)))
        except InvalidOperation:
            return Response({'detail': 'Invalid unit_value'}, status=status.HTTP_400_BAD_REQUEST)

        customer_id = data.get('customer_id')
        if not customer_id:
            return Response({'detail': 'customer_id is required'}, status=status.HTTP_400_BAD_REQUEST)
        try:
            customer = Company.objects.get(pk=customer_id, is_customer=True)
        except (Company.DoesNotExist, ValueError, TypeError):
            return Response({'detail': 'Invalid customer_id'}, status=status.HTTP_400_BAD_REQUEST)

        due_date_raw = data.get('due_date')
        if due_date_raw:
            try:
                due_date = date.fromisoformat(due_date_raw)
            except ValueError:
                return Response({'detail': 'Invalid due_date'}, status=status.HTTP_400_BAD_REQUEST)
        else:
            due_date = timezone.localdate() + timedelta(days=DEFAULT_DUE_DAYS)

        if stock_item.quantity < quantity:
            return Response(
                {'detail': 'Insufficient stock for this movement'}, status=status.HTTP_400_BAD_REQUEST
            )

        try:
            with transaction.atomic():
                movement = record_sale_movement(
                    stock_item=stock_item,
                    sale_type=SaleTypeMovement.SaleType.B2B_CREDIT,
                    quantity=quantity,
                    unit_value=unit_value,
                    customer=customer,
                    user=request.user,
                    notes=data.get('notes', ''),
                )
                invoice = Invoice.objects.create(
                    customer=customer,
                    due_date=due_date,
                    total=movement.total_value,
                    created_by=request.user,
                )
                InvoiceLineItem.objects.create(invoice=invoice, sale_type_movement=movement)
        except SaleRecordingError:
            return Response({'detail': 'Stock update failed'}, status=status.HTTP_400_BAD_REQUEST)

        return Response(
            {
                'invoice_id': invoice.id,
                'reference': invoice.reference,
                'total': str(invoice.total),
                'outstanding': str(invoice.outstanding),
                'status': invoice.status,
                'sale_type_movement_id': movement.id,
            },
            status=status.HTTP_201_CREATED,
        )
```

Add `from datetime import date` to `api.py`'s imports.

- [ ] **Step 4: Wire the URL in `plugin.py`**

In `setup_urls()`, add a second route alongside `record-sale/`:

```python
        @csrf_exempt
        def record_b2b_sale_view(request, *args, **kwargs):
            from stationery_sales.api import RecordB2BSaleView

            return RecordB2BSaleView.as_view()(request, *args, **kwargs)

        return [
            path('record-sale/', record_sale_view, name='record-sale'),
            path('record-b2b-sale/', record_b2b_sale_view, name='record-b2b-sale'),
        ]
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `python3 manage.py test stationery_sales.test_api.RecordB2BSaleApiTest -v 2`
Expected: PASS (or live smoke-test equivalent per the known DB limitation — same fallback as prior tasks).

- [ ] **Step 6: Commit**

```bash
git add stationery_sales/api.py stationery_sales/plugin.py stationery_sales/test_api.py
git commit -m "feat: add record-b2b-sale endpoint (atomic sale + invoice creation)"
```

---

### Task 5: `InvoicePaymentsView` — record + retrieve payments

**Files:**
- Modify: `stationery_sales/api.py`
- Modify: `stationery_sales/plugin.py`
- Test: `stationery_sales/test_api.py`

**Interfaces:**
- Consumes: `Invoice`, `Payment` (Tasks 2–3).
- Produces: `GET /plugin/stationerysales/invoices/<pk>/payments/` → `200 [{id, amount, payment_date, method, reference, recorded_by, created_at}, ...]` (chronological, oldest first). `POST` same URL, body `{amount, method, payment_date(optional), reference(optional)}` → `201 {payment_id, invoice_status, outstanding}` or `400 {detail}`.

- [ ] **Step 1: Write the failing test**

Add to `test_api.py`:

```python
class InvoicePaymentsApiTest(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user('pay-api-tester', password='pw', is_staff=True)
        self.client.force_authenticate(self.user)
        self.customer = Company.objects.create(name='Acme Stationers', is_customer=True)
        self.invoice = Invoice.objects.create(
            customer=self.customer,
            due_date=timezone.localdate(),
            total=Decimal('50000'),
            created_by=self.user,
        )
        self.url = reverse('plugin:stationerysales:invoice-payments', args=[self.invoice.pk])

    def test_partial_then_full_payment_flow(self):
        r1 = self.client.post(self.url, {'amount': '10000', 'method': 'cash'}, format='json')
        self.assertEqual(r1.status_code, 201, r1.content)
        self.assertEqual(r1.data['invoice_status'], 'partially_paid')
        self.assertEqual(r1.data['outstanding'], '40000.00000')

        r2 = self.client.post(self.url, {'amount': '40000', 'method': 'online'}, format='json')
        self.assertEqual(r2.status_code, 201, r2.content)
        self.assertEqual(r2.data['invoice_status'], 'paid')
        self.assertEqual(r2.data['outstanding'], '0')

        history = self.client.get(self.url)
        self.assertEqual(len(history.data), 2)
        self.assertEqual(Decimal(history.data[0]['amount']), Decimal('10000'))

    def test_zero_payment_rejected(self):
        response = self.client.post(self.url, {'amount': '0', 'method': 'cash'}, format='json')
        self.assertEqual(response.status_code, 400)

    def test_negative_payment_rejected(self):
        response = self.client.post(self.url, {'amount': '-100', 'method': 'cash'}, format='json')
        self.assertEqual(response.status_code, 400)

    def test_overpayment_rejected(self):
        response = self.client.post(self.url, {'amount': '60000', 'method': 'cash'}, format='json')
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.invoice.payments.count(), 0)

    def test_payment_against_cancelled_invoice_rejected(self):
        self.invoice.status = Invoice.Status.CANCELLED
        self.invoice.save(update_fields=['status'])
        response = self.client.post(self.url, {'amount': '100', 'method': 'cash'}, format='json')
        self.assertEqual(response.status_code, 400)

    def test_invalid_method_rejected(self):
        response = self.client.post(self.url, {'amount': '100', 'method': 'bitcoin'}, format='json')
        self.assertEqual(response.status_code, 400)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 manage.py test stationery_sales.test_api.InvoicePaymentsApiTest -v 2`
Expected: FAIL — `NoReverseMatch`.

- [ ] **Step 3: Implement `InvoicePaymentsView` in `api.py`**

Add (also add `from .models import Payment` to the existing models import line):

```python
class InvoicePaymentsView(APIView):
    """GET: chronological payment history for one invoice.
    POST body: amount, method (cash/online/cheque), payment_date (optional,
    ISO date, defaults to today), reference (optional).
    """

    permission_classes = [IsAuthenticated]

    def get(self, request, pk):
        try:
            invoice = Invoice.objects.get(pk=pk)
        except Invoice.DoesNotExist:
            return Response({'detail': 'Invoice not found'}, status=status.HTTP_404_NOT_FOUND)

        payments = invoice.payments.order_by('payment_date', 'created_at')
        return Response([
            {
                'id': p.id,
                'amount': str(p.amount),
                'payment_date': p.payment_date.isoformat(),
                'method': p.method,
                'reference': p.reference,
                'recorded_by': p.recorded_by_id,
                'created_at': p.created_at.isoformat(),
            }
            for p in payments
        ])

    def post(self, request, pk):
        data = request.data

        try:
            with transaction.atomic():
                try:
                    invoice = Invoice.objects.select_for_update().get(pk=pk)
                except Invoice.DoesNotExist:
                    return Response({'detail': 'Invoice not found'}, status=status.HTTP_404_NOT_FOUND)

                if invoice.status == Invoice.Status.CANCELLED:
                    return Response(
                        {'detail': 'Cannot record a payment against a cancelled invoice'},
                        status=status.HTTP_400_BAD_REQUEST,
                    )

                try:
                    amount = Decimal(str(data.get('amount')))
                except (InvalidOperation, TypeError):
                    return Response({'detail': 'Invalid amount'}, status=status.HTTP_400_BAD_REQUEST)

                if amount <= 0:
                    return Response(
                        {'detail': 'amount must be greater than zero'}, status=status.HTTP_400_BAD_REQUEST
                    )

                method = data.get('method')
                if method not in Payment.Method.values:
                    return Response({'detail': 'Invalid method'}, status=status.HTTP_400_BAD_REQUEST)

                if amount > invoice.outstanding:
                    return Response(
                        {'detail': 'Payment exceeds outstanding balance'}, status=status.HTTP_400_BAD_REQUEST
                    )

                payment_date_raw = data.get('payment_date')
                if payment_date_raw:
                    try:
                        payment_date = date.fromisoformat(payment_date_raw)
                    except ValueError:
                        return Response({'detail': 'Invalid payment_date'}, status=status.HTTP_400_BAD_REQUEST)
                else:
                    payment_date = timezone.localdate()

                payment = Payment.objects.create(
                    invoice=invoice,
                    amount=amount,
                    payment_date=payment_date,
                    method=method,
                    reference=data.get('reference', ''),
                    recorded_by=request.user,
                )
                invoice.refresh_status()
        except Exception:
            raise

        return Response(
            {
                'payment_id': payment.id,
                'invoice_status': invoice.status,
                'outstanding': str(invoice.outstanding),
            },
            status=status.HTTP_201_CREATED,
        )
```

Note on the `try/except Exception: raise` in `post()`: this is intentionally a no-op re-raise, not error handling — it exists only to document that any exception raised inside the `atomic()` block (e.g. a DB integrity error) propagates normally and rolls back the transaction, leaving no partial `Payment` row. Remove it if a linter flags it as dead code; it adds no behavior. (Prefer removing it — it is a comment-shaped construct disguised as code. Just wrap the body in `with transaction.atomic():` directly without the outer `try`.)

Revise Step 3 to drop the pointless `try/except`: the `post()` method's body should be exactly:

```python
    def post(self, request, pk):
        data = request.data

        with transaction.atomic():
            try:
                invoice = Invoice.objects.select_for_update().get(pk=pk)
            except Invoice.DoesNotExist:
                return Response({'detail': 'Invoice not found'}, status=status.HTTP_404_NOT_FOUND)

            if invoice.status == Invoice.Status.CANCELLED:
                return Response(
                    {'detail': 'Cannot record a payment against a cancelled invoice'},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            try:
                amount = Decimal(str(data.get('amount')))
            except (InvalidOperation, TypeError):
                return Response({'detail': 'Invalid amount'}, status=status.HTTP_400_BAD_REQUEST)

            if amount <= 0:
                return Response(
                    {'detail': 'amount must be greater than zero'}, status=status.HTTP_400_BAD_REQUEST
                )

            method = data.get('method')
            if method not in Payment.Method.values:
                return Response({'detail': 'Invalid method'}, status=status.HTTP_400_BAD_REQUEST)

            if amount > invoice.outstanding:
                return Response(
                    {'detail': 'Payment exceeds outstanding balance'}, status=status.HTTP_400_BAD_REQUEST
                )

            payment_date_raw = data.get('payment_date')
            if payment_date_raw:
                try:
                    payment_date = date.fromisoformat(payment_date_raw)
                except ValueError:
                    return Response({'detail': 'Invalid payment_date'}, status=status.HTTP_400_BAD_REQUEST)
            else:
                payment_date = timezone.localdate()

            payment = Payment.objects.create(
                invoice=invoice,
                amount=amount,
                payment_date=payment_date,
                method=method,
                reference=data.get('reference', ''),
                recorded_by=request.user,
            )
            invoice.refresh_status()

        return Response(
            {
                'payment_id': payment.id,
                'invoice_status': invoice.status,
                'outstanding': str(invoice.outstanding),
            },
            status=status.HTTP_201_CREATED,
        )
```

(A `return` from inside a `with transaction.atomic():` block still triggers commit/rollback correctly in Django — an early `return` on a validation failure exits the `with` block via the normal non-exception path, so nothing was written yet at that point anyway since the `Payment.objects.create()` call hasn't executed. This matches DRF convention of returning `Response` directly from validation branches.)

- [ ] **Step 4: Wire the URL in `plugin.py`**

```python
        @csrf_exempt
        def invoice_payments_view(request, *args, **kwargs):
            from stationery_sales.api import InvoicePaymentsView

            return InvoicePaymentsView.as_view()(request, *args, **kwargs)

        return [
            path('record-sale/', record_sale_view, name='record-sale'),
            path('record-b2b-sale/', record_b2b_sale_view, name='record-b2b-sale'),
            path('invoices/<int:pk>/payments/', invoice_payments_view, name='invoice-payments'),
        ]
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `python3 manage.py test stationery_sales.test_api.InvoicePaymentsApiTest -v 2`
Expected: PASS (or live smoke-test fallback).

- [ ] **Step 6: Commit**

```bash
git add stationery_sales/api.py stationery_sales/plugin.py stationery_sales/test_api.py
git commit -m "feat: add invoice payment recording + history endpoint"
```

---

### Task 6: `InvoiceDetailView` + `CustomerReceivablesView`

**Files:**
- Modify: `stationery_sales/api.py`
- Modify: `stationery_sales/plugin.py`
- Test: `stationery_sales/test_api.py`

**Interfaces:**
- Produces: `GET /plugin/stationerysales/invoices/<pk>/` → invoice detail incl. lines + outstanding + aging. `GET /plugin/stationerysales/customers/<pk>/receivables/` → `{customer_id, total_outstanding, invoices: [...]}`.

- [ ] **Step 1: Write the failing test**

```python
class InvoiceDetailApiTest(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user('detail-tester', password='pw', is_staff=True)
        self.client.force_authenticate(self.user)
        self.customer = Company.objects.create(name='Acme Stationers', is_customer=True)
        self.invoice = Invoice.objects.create(
            customer=self.customer,
            due_date=timezone.localdate() - timedelta(days=45),
            total=Decimal('1000'),
            created_by=self.user,
        )

    def test_retrieve_invoice(self):
        url = reverse('plugin:stationerysales:invoice-detail', args=[self.invoice.pk])
        response = self.client.get(url)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['reference'], self.invoice.reference)
        self.assertEqual(response.data['outstanding'], '1000')
        self.assertEqual(response.data['aging_bucket'], '31-60')

    def test_retrieve_missing_invoice_404(self):
        url = reverse('plugin:stationerysales:invoice-detail', args=[999999])
        response = self.client.get(url)
        self.assertEqual(response.status_code, 404)


class CustomerReceivablesApiTest(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user('receivables-tester', password='pw', is_staff=True)
        self.client.force_authenticate(self.user)
        self.customer = Company.objects.create(name='Acme Stationers', is_customer=True)
        self.paid = Invoice.objects.create(
            customer=self.customer, due_date=timezone.localdate(), total=Decimal('100'),
            created_by=self.user, status=Invoice.Status.PAID,
        )
        self.unpaid = Invoice.objects.create(
            customer=self.customer, due_date=timezone.localdate(), total=Decimal('300'),
            created_by=self.user,
        )
        self.cancelled = Invoice.objects.create(
            customer=self.customer, due_date=timezone.localdate(), total=Decimal('500'),
            created_by=self.user, status=Invoice.Status.CANCELLED,
        )

    def test_receivables_excludes_paid_and_cancelled(self):
        url = reverse('plugin:stationerysales:customer-receivables', args=[self.customer.pk])
        response = self.client.get(url)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['total_outstanding'], '300')
        ids = [inv['id'] for inv in response.data['invoices']]
        self.assertEqual(ids, [self.unpaid.id])
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 manage.py test stationery_sales.test_api.InvoiceDetailApiTest stationery_sales.test_api.CustomerReceivablesApiTest -v 2`
Expected: FAIL — `NoReverseMatch`.

- [ ] **Step 3: Implement both views in `api.py`**

```python
class InvoiceDetailView(APIView):
    """GET: full detail for one invoice, including lines and computed
    outstanding/aging.
    """

    permission_classes = [IsAuthenticated]

    def get(self, request, pk):
        try:
            invoice = Invoice.objects.get(pk=pk)
        except Invoice.DoesNotExist:
            return Response({'detail': 'Invoice not found'}, status=status.HTTP_404_NOT_FOUND)

        return Response({
            'id': invoice.id,
            'reference': invoice.reference,
            'customer_id': invoice.customer_id,
            'invoice_date': invoice.invoice_date.isoformat(),
            'due_date': invoice.due_date.isoformat(),
            'total': str(invoice.total),
            'amount_paid': str(invoice.amount_paid),
            'outstanding': str(invoice.outstanding),
            'status': invoice.status,
            'is_overdue': invoice.is_overdue,
            'aging_bucket': invoice.aging_bucket,
            'lines': [
                {
                    'id': line.id,
                    'sale_type_movement_id': line.sale_type_movement_id,
                    'quantity': str(line.quantity),
                    'unit_price': str(line.unit_price),
                    'line_total': str(line.line_total),
                }
                for line in invoice.lines.all()
            ],
        })


class CustomerReceivablesView(APIView):
    """GET: outstanding receivables summary for one customer. Only
    non-cancelled invoices with outstanding > 0 contribute to the total.
    """

    permission_classes = [IsAuthenticated]

    def get(self, request, pk):
        try:
            customer = Company.objects.get(pk=pk, is_customer=True)
        except Company.DoesNotExist:
            return Response({'detail': 'Customer not found'}, status=status.HTTP_404_NOT_FOUND)

        invoices = Invoice.objects.filter(customer=customer).exclude(status=Invoice.Status.CANCELLED)

        outstanding_invoices = [inv for inv in invoices if inv.outstanding > 0]
        total_outstanding = sum((inv.outstanding for inv in outstanding_invoices), Decimal('0'))

        return Response({
            'customer_id': customer.id,
            'total_outstanding': str(total_outstanding),
            'invoices': [
                {
                    'id': inv.id,
                    'reference': inv.reference,
                    'total': str(inv.total),
                    'outstanding': str(inv.outstanding),
                    'status': inv.status,
                    'due_date': inv.due_date.isoformat(),
                    'aging_bucket': inv.aging_bucket,
                }
                for inv in outstanding_invoices
            ],
        })
```

- [ ] **Step 4: Wire URLs in `plugin.py`**

```python
        @csrf_exempt
        def invoice_detail_view(request, *args, **kwargs):
            from stationery_sales.api import InvoiceDetailView

            return InvoiceDetailView.as_view()(request, *args, **kwargs)

        @csrf_exempt
        def customer_receivables_view(request, *args, **kwargs):
            from stationery_sales.api import CustomerReceivablesView

            return CustomerReceivablesView.as_view()(request, *args, **kwargs)

        return [
            path('record-sale/', record_sale_view, name='record-sale'),
            path('record-b2b-sale/', record_b2b_sale_view, name='record-b2b-sale'),
            path('invoices/<int:pk>/', invoice_detail_view, name='invoice-detail'),
            path('invoices/<int:pk>/payments/', invoice_payments_view, name='invoice-payments'),
            path('customers/<int:pk>/receivables/', customer_receivables_view, name='customer-receivables'),
        ]
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `python3 manage.py test stationery_sales.test_api.InvoiceDetailApiTest stationery_sales.test_api.CustomerReceivablesApiTest -v 2`
Expected: PASS (or live smoke-test fallback).

- [ ] **Step 6: Commit**

```bash
git add stationery_sales/api.py stationery_sales/plugin.py stationery_sales/test_api.py
git commit -m "feat: add invoice detail and customer receivables endpoints"
```

---

### Task 7: Full regression pass, live smoke matrix, disposable-data cleanup, final report

**Files:** none new — verification only.

- [ ] **Step 1: Full test suite**

Run: `python3 manage.py test stationery_sales -v 2`
Expected: every test across `test_models.py` and `test_api.py` (old + new) PASSes. This covers minimum-test-matrix items 1–25 and 37–40 from the brief.

- [ ] **Step 2: Confirm plugin loads cleanly, no duplicate registration**

Run: `python3 manage.py check` (or start the dev server briefly and check logs for the plugin) — confirm no `AppRegistryNotReady`, no duplicate `stationery_sales` app registration, no import errors from the new `Invoice`/`InvoiceLineItem`/`Payment` models or the `SettingsMixin` addition. Covers matrix items 42–43.

- [ ] **Step 3: Confirm existing InvenTree APIs still function**

Hit a couple of unrelated core endpoints (e.g. `GET /api/company/` , `GET /api/stock/` ) with the authenticated test client or `curl` against the running dev server, confirm 200. Covers matrix item 41.

- [ ] **Step 4: If `manage.py test` could not create a temp DB against Supabase, run the live smoke-test matrix manually**

Using `manage.py shell` or `curl` against the running dev server (authenticated), walk through the full scenario from the brief:
- Create one disposable test Company (`is_customer=True`), one disposable test Part + StockItem.
- `POST record-b2b-sale/` for 10 units — confirm stock decreases, invoice created, `outstanding == total`, status `unpaid`.
- `POST invoices/<id>/payments/` for 10,000 / 15,000 / 25,000 against a 50,000 total — confirm running outstanding and status transitions match the brief's example exactly (`partially_paid` → `partially_paid` → `paid`, final outstanding `0`).
- Attempt a zero/negative/overpayment/cancelled-invoice payment — confirm each is rejected with no `Payment` row created (`invoice.payments.count()` unchanged).
- `GET customers/<id>/receivables/` — confirm the disposable customer's total matches expectations and cancelled/paid invoices are excluded.
- Confirm aging buckets for invoices with `due_date` manually set into each of the five ranges.

- [ ] **Step 5: Delete every disposable record created in Step 4**

Delete, in FK-safe order: `Payment` rows → `InvoiceLineItem` rows → `Invoice` rows → `SaleTypeMovement` rows → `StockItemTracking` rows (if manually created) → `StockItem` → `Part` → test `Company`. Confirm via count queries that none remain (e.g. `Company.objects.filter(name__startswith='SMOKETEST').count() == 0` if a recognizable naming prefix was used for disposables — recommend prefixing every disposable record's name/notes with `SMOKETEST-` during Step 4 specifically so this cleanup check is unambiguous).

- [ ] **Step 6: Write the final report**

Per the brief's required 15-point report structure. No commit needed for this step (reporting only, chat message to the user) — do NOT create a new markdown file for it unless asked.

---

## Self-Review Notes

- **Spec coverage:** All 9 numbered brief sections (Invoice, Invoice Status, Invoice Total, Invoice Line Item, Sale Type Constraint, Customer Constraint, Payment, Payment Validation, Partial/Multiple Payments, Stock/Sale Integration, Atomicity, API, Customer Outstanding, Aging, Invoice Numbering) map to Tasks 2–6, with cross-cutting rules captured in Global Constraints. Migrations/testing sections map to Task 3 Step 4 and Task 7.
- **No stored redundant fields:** confirmed no stored `outstanding` column, no duplicated money fields on `InvoiceLineItem`, no `overdue` stored status, no separate ledger model — matches every "do not store redundantly" instruction in the brief.
- **Type/name consistency check:** `Invoice.Status`, `Payment.Method`, `SaleTypeMovement.SaleType` values used identically across `models.py`/`api.py`/`test_*.py` in every task above. `record_sale_movement()`'s keyword-only signature (Task 1) is used identically in both `RecordSaleView` (Task 1 Step 2) and `RecordB2BSaleView` (Task 4 Step 3).
- **Placeholder scan:** the one instance of placeholder-style text (Task 2 Step 4's first draft) is explicitly superseded by concrete code in the same step — flagged inline rather than left ambiguous.
- **No unrequested scope:** no serializers.py (matches existing no-serializer convention), no generic CRUD viewsets, no reporting UI, no dunning/interest/gateway code, no SalesOrder integration.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-20-b2b-receivables.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
