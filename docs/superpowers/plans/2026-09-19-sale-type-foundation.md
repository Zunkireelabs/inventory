# Sale-Type Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give InvenTree a first-class sale-type dimension (B2B-credit / B2C-cash / B2C-online / Gift / Restock / Correction) on every stock-out/in event, without forking InvenTree core — the foundation everything else in the gap audit (gift valuation, B2B receivables, reporting) depends on.

**Architecture:** A local InvenTree plugin (`plugins/stationery_sales/`) using the officially-documented local-plugin-directory mechanism (`InvenTree.registry.plugin_dirs()` always scans the `plugins` top-level package — zero core changes, zero config needed). The plugin registers its own Django app (via `AppMixin`) holding one new model, `SaleTypeMovement`, which links to InvenTree's existing `StockItemTracking` entries rather than replacing them. One atomic API endpoint (`UrlsMixin` + a DRF `APIView`) creates both the InvenTree stock movement (via `StockItem.take_stock()`/`add_stock()`, InvenTree's own API — never touched directly) and our `SaleTypeMovement` row, in one DB transaction.

**Tech Stack:** Django 5 (InvenTree's stack), DRF, Postgres (Supabase-hosted, project `opbpggeehregcmxmbhwr` — already linked, do not touch connection config), InvenTree plugin framework (`AppMixin`, `UrlsMixin`).

**Spec:** `docs/superpowers/specs/2026-09-19-brief-scope-gap-audit.md` (this repo) — gap #1 ("Sale-type dimension"), and the original `BRIEF.md`/`SCOPE.md` from the sibling Next.js project (same business brief, read there for the exact sale-type semantics this mirrors).

## Global Constraints

- Do not modify any file under `part/`, `stock/`, `order/`, `company/` — this plan is additive-only, unlike the earlier backend Part→Product rename (which was a justified exception for translation strings only).
- Single location, no lot/batch/serial tracking (confirmed in SCOPE.md exclusions) — each `Part` is assumed to have exactly one active non-serialized `StockItem` representing total quantity on hand. The API takes an explicit `stock_item_id` (not inferred) to stay consistent with how InvenTree's own stock UI already requires picking a specific StockItem — this plan does not change that requirement, just doesn't try to be clever about picking one automatically.
- `sale_type` values mirror the Next.js project's enum exactly for terminology consistency across both codebases: `b2b_credit`, `b2c_cash`, `b2c_online`, `gift`, `restock`, `correction`.
- Verification convention for this repo: `invoke test --runtest=<app_label>` (Django's test runner, not pytest — confirmed via `tasks.py`).
- Every migration must be generated via `manage.py makemigrations`, never hand-written — Django's migration framework tracks model state and hand-written migrations drift from it.
- Do NOT touch `opbpggeehregcmxmbhwr` with anything destructive — this plan only adds a new table, never alters/drops existing InvenTree tables.

---

### Task 1: Plugin scaffold + `SaleTypeMovement` model

**Files:**
- Create: `src/backend/InvenTree/plugins/stationery_sales/__init__.py`
- Create: `src/backend/InvenTree/plugins/stationery_sales/plugin.py`
- Create: `src/backend/InvenTree/plugins/stationery_sales/models.py`
- Create: `src/backend/InvenTree/plugins/stationery_sales/migrations/__init__.py`
- Test: `src/backend/InvenTree/plugins/stationery_sales/test_models.py`

**Interfaces:**
- Consumes: `stock.models.StockItemTracking` (existing, FK target), `part.models.Part` (existing, FK target), `company.models.Company` (existing, FK target, filtered `is_customer=True` at the form/API layer in Task 2 — no model-level constraint needed since Django doesn't support conditional FK constraints).
- Produces: `SaleTypeMovement` model with fields `id, tracking_entry (OneToOne to StockItemTracking), part (FK), sale_type (CharField, choices), quantity (DecimalField), unit_value (DecimalField), total_value (DecimalField), customer (FK, nullable), notes (TextField, blank), created_by (FK to auth User), created_at (DateTimeField, auto_now_add)`. Task 2's API view creates instances of this model. Task 3+ (gift valuation, receivables) will read from it.

- [ ] **Step 1: Create the plugin package**

```python
# src/backend/InvenTree/plugins/stationery_sales/__init__.py
"""Stationery Sales plugin: adds a first-class sale-type dimension to stock movements."""
```

- [ ] **Step 2: Write the plugin descriptor**

```python
# src/backend/InvenTree/plugins/stationery_sales/plugin.py
"""Plugin definition for stationery_sales."""

from plugin import InvenTreePlugin
from plugin.mixins import AppMixin, UrlsMixin


class StationerySalesPlugin(AppMixin, UrlsMixin, InvenTreePlugin):
    """Adds sale-type tracking (B2B credit / B2C cash / B2C online / Gift / Restock / Correction) on top of InvenTree's stock model, without modifying core."""

    NAME = 'StationerySales'
    SLUG = 'stationerysales'
    TITLE = 'Stationery Sales'
    AUTHOR = 'internal'
    DESCRIPTION = 'First-class sale-type dimension for stock movements'
    VERSION = '0.1.0'

    def setup_urls(self):
        """No URLs yet — added in Task 2."""
        return []
```

- [ ] **Step 3: Write the failing test for the model**

```python
# src/backend/InvenTree/plugins/stationery_sales/test_models.py
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.test import TestCase

from company.models import Company
from part.models import Part
from stock.models import StockItem, StockItemTracking
from stock.status_codes import StockHistoryCode

from .models import SaleTypeMovement

User = get_user_model()


class SaleTypeMovementTest(TestCase):
    def setUp(self):
        self.user = User.objects.create_user('tester', password='pw')
        self.part = Part.objects.create(name='Test Pen', description='Test', active=True)
        self.stock_item = StockItem.objects.create(part=self.part, quantity=10)
        self.tracking = StockItemTracking.objects.create(
            item=self.stock_item, tracking_type=StockHistoryCode.STOCK_REMOVE
        )

    def test_create_gift_movement(self):
        movement = SaleTypeMovement.objects.create(
            tracking_entry=self.tracking,
            part=self.part,
            sale_type=SaleTypeMovement.SaleType.GIFT,
            quantity=Decimal('2'),
            unit_value=Decimal('50.00'),
            total_value=Decimal('100.00'),
            notes='test gift',
            created_by=self.user,
        )
        self.assertEqual(movement.sale_type, 'gift')
        self.assertIsNone(movement.customer)

    def test_create_b2b_credit_movement_requires_customer_at_app_layer(self):
        # Model itself allows a null customer — the API layer (Task 2) enforces
        # b2b_credit requires a customer, mirroring the Next.js schema's
        # b2b_requires_customer check constraint. Verified here at the model
        # level only that the field accepts a Company.
        customer = Company.objects.create(name='Test Customer', is_customer=True)
        movement = SaleTypeMovement.objects.create(
            tracking_entry=StockItemTracking.objects.create(
                item=self.stock_item, tracking_type=StockHistoryCode.STOCK_REMOVE
            ),
            part=self.part,
            sale_type=SaleTypeMovement.SaleType.B2B_CREDIT,
            quantity=Decimal('1'),
            unit_value=Decimal('50.00'),
            total_value=Decimal('50.00'),
            customer=customer,
            created_by=self.user,
        )
        self.assertEqual(movement.customer, customer)
```

- [ ] **Step 4: Run test to verify it fails (model doesn't exist yet)**

Run: `cd src/backend/InvenTree && source ../../../.venv/bin/activate 2>/dev/null; set -a; source ../../../.env; set +a; python3 manage.py test plugins.stationery_sales -v 2`
Expected: FAIL — `ModuleNotFoundError: No module named 'plugins.stationery_sales.models'` or similar (module doesn't exist).

- [ ] **Step 5: Write the model**

```python
# src/backend/InvenTree/plugins/stationery_sales/models.py
"""SaleTypeMovement: first-class sale-type dimension linked to InvenTree's own stock tracking."""

from django.conf import settings
from django.db import models


class SaleTypeMovement(models.Model):
    """One row per sale-type-tagged stock movement, linked 1:1 to the InvenTree
    StockItemTracking entry it corresponds to. InvenTree's own tracking entry
    remains the source of truth for the physical stock change; this table adds
    the business dimension (why did the stock move) on top of it.
    """

    class SaleType(models.TextChoices):
        B2B_CREDIT = 'b2b_credit', 'B2B Credit'
        B2C_CASH = 'b2c_cash', 'B2C Cash'
        B2C_ONLINE = 'b2c_online', 'B2C Online'
        GIFT = 'gift', 'Gift'
        RESTOCK = 'restock', 'Restock'
        CORRECTION = 'correction', 'Correction'

    tracking_entry = models.OneToOneField(
        'stock.StockItemTracking',
        on_delete=models.CASCADE,
        related_name='sale_type_movement',
    )
    part = models.ForeignKey('part.Part', on_delete=models.PROTECT, related_name='+')
    sale_type = models.CharField(max_length=20, choices=SaleType.choices)
    quantity = models.DecimalField(max_digits=15, decimal_places=5)
    unit_value = models.DecimalField(max_digits=15, decimal_places=5, default=0)
    total_value = models.DecimalField(max_digits=15, decimal_places=5, default=0)
    customer = models.ForeignKey(
        'company.Company', on_delete=models.PROTECT, related_name='+', null=True, blank=True
    )
    notes = models.TextField(blank=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name='+'
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f'{self.get_sale_type_display()} — {self.part} x{self.quantity}'
```

- [ ] **Step 6: Generate the migration**

Run: `cd src/backend/InvenTree && python3 manage.py makemigrations plugins.stationery_sales`
Expected: creates `plugins/stationery_sales/migrations/0001_initial.py`. Also manually create the empty `migrations/__init__.py` first if `makemigrations` doesn't (Django usually creates it automatically alongside the first migration).

- [ ] **Step 7: Activate the plugin (one-time manual step — plugins are DB-activated, not migration-activated)**

Run: `cd src/backend/InvenTree && python3 manage.py shell -c "from plugin.models import PluginConfig; PluginConfig.objects.update_or_create(key='stationerysales', defaults={'active': True})"`

This is InvenTree's standard plugin-activation mechanism (normally done via Settings → Plugins → toggle Active in the UI) — doing it via shell here since we're scripting setup, not clicking through the UI. Confirm it worked: `python3 manage.py shell -c "from plugin.models import PluginConfig; print(PluginConfig.objects.get(key='stationerysales').active)"` should print `True`.

- [ ] **Step 8: Apply the migration**

Run: `cd src/backend/InvenTree && python3 manage.py migrate`
Expected: `Applying plugins.stationery_sales.0001_initial... OK`

- [ ] **Step 9: Run test to verify it passes**

Run: `python3 manage.py test plugins.stationery_sales -v 2`
Expected: both tests PASS.

- [ ] **Step 10: Commit**

```bash
git add src/backend/InvenTree/plugins/stationery_sales
git commit -m "feat: add SaleTypeMovement model as a local InvenTree plugin"
```

---

### Task 2: Atomic `record-sale` API endpoint

**Files:**
- Create: `src/backend/InvenTree/plugins/stationery_sales/api.py`
- Modify: `src/backend/InvenTree/plugins/stationery_sales/plugin.py` (wire up `setup_urls`)
- Test: `src/backend/InvenTree/plugins/stationery_sales/test_api.py`

**Interfaces:**
- Consumes: `SaleTypeMovement` (Task 1), `stock.models.StockItem.take_stock(quantity, user, code=StockHistoryCode.STOCK_REMOVE, notes='', record_tracking=True)` (existing InvenTree method, confirmed signature via direct source read — returns `bool`), `StockItem.add_stock(quantity, user, notes='')` (for `restock`/positive `correction`, existing method, returns `bool`), `StockItem.add_tracking_entry(entry_type, user, deltas=None, notes='', commit=True)` (existing, **returns the created `StockItemTracking` — this is what we link `SaleTypeMovement.tracking_entry` to**).
- Produces: `POST /api/plugin/stationerysales/record-sale/` — request body `{stock_item_id, sale_type, quantity, unit_value?, customer_id?, notes?}`, response `{id: <SaleTypeMovement id>}` on success, `400` with `{detail: "..."}` on validation failure. No other task in this plan consumes this yet (Task 3+ will, for gift valuation and reporting).

- [ ] **Step 1: Write the failing test**

```python
# src/backend/InvenTree/plugins/stationery_sales/test_api.py
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.urls import reverse
from rest_framework.test import APITestCase

from company.models import Company
from part.models import Part
from stock.models import StockItem

from .models import SaleTypeMovement

User = get_user_model()


class RecordSaleApiTest(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user('tester', password='pw', is_staff=True)
        self.client.force_authenticate(self.user)
        self.part = Part.objects.create(
            name='Test Pen', description='Test', active=True, purchaseable=True, salable=True
        )
        self.stock_item = StockItem.objects.create(part=self.part, quantity=10)
        self.url = reverse('plugin:stationerysales:record-sale')

    def test_record_gift_reduces_stock_and_creates_movement(self):
        response = self.client.post(
            self.url,
            {
                'stock_item_id': self.stock_item.pk,
                'sale_type': 'gift',
                'quantity': '2',
                'unit_value': '50.00',
                'notes': 'test gift',
            },
            format='json',
        )
        self.assertEqual(response.status_code, 201, response.content)
        self.stock_item.refresh_from_db()
        self.assertEqual(self.stock_item.quantity, 8)
        movement = SaleTypeMovement.objects.get(id=response.data['id'])
        self.assertEqual(movement.sale_type, 'gift')
        self.assertEqual(movement.total_value, Decimal('100.00'))

    def test_b2b_credit_requires_customer(self):
        response = self.client.post(
            self.url,
            {
                'stock_item_id': self.stock_item.pk,
                'sale_type': 'b2b_credit',
                'quantity': '1',
                'unit_value': '50.00',
            },
            format='json',
        )
        self.assertEqual(response.status_code, 400)
        self.stock_item.refresh_from_db()
        self.assertEqual(self.stock_item.quantity, 10)  # unchanged — atomic rollback

    def test_restock_increases_stock(self):
        response = self.client.post(
            self.url,
            {
                'stock_item_id': self.stock_item.pk,
                'sale_type': 'restock',
                'quantity': '5',
                'unit_value': '30.00',
            },
            format='json',
        )
        self.assertEqual(response.status_code, 201, response.content)
        self.stock_item.refresh_from_db()
        self.assertEqual(self.stock_item.quantity, 15)

    def test_insufficient_stock_rejected(self):
        response = self.client.post(
            self.url,
            {
                'stock_item_id': self.stock_item.pk,
                'sale_type': 'b2c_cash',
                'quantity': '999',
                'unit_value': '50.00',
            },
            format='json',
        )
        self.assertEqual(response.status_code, 400)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 manage.py test plugins.stationery_sales.test_api -v 2`
Expected: FAIL — `NoReverseMatch` (URL not registered yet).

- [ ] **Step 3: Write the API view**

```python
# src/backend/InvenTree/plugins/stationery_sales/api.py
"""API endpoint for recording a sale-type-tagged stock movement atomically."""

from decimal import Decimal, InvalidOperation

from django.db import transaction
from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from company.models import Company
from stock.models import StockItem
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

        if sale_type in OUTBOUND_TYPES and stock_item.quantity < quantity:
            return Response(
                {'detail': 'Insufficient stock for this movement'}, status=status.HTTP_400_BAD_REQUEST
            )

        tracking_code = TRACKING_CODE_BY_SALE_TYPE[sale_type]

        with transaction.atomic():
            if sale_type in OUTBOUND_TYPES:
                ok = stock_item.take_stock(
                    quantity, request.user, code=tracking_code, notes=data.get('notes', ''),
                    record_tracking=False,
                )
            else:
                ok = stock_item.add_stock(quantity, request.user, notes=data.get('notes', ''))
                # add_stock's own add_tracking_entry() cannot be skipped via a
                # kwarg (unlike take_stock's record_tracking=False) — so for
                # restock/correction we let it create InvenTree's own tracking
                # entry, then fetch that same entry below instead of creating
                # a second one.
            if not ok:
                return Response(
                    {'detail': 'Stock update failed'}, status=status.HTTP_400_BAD_REQUEST
                )

            if sale_type in OUTBOUND_TYPES:
                tracking_entry = stock_item.add_tracking_entry(
                    tracking_code, request.user, notes=data.get('notes', ''),
                    deltas={'removed': float(quantity), 'quantity': float(stock_item.quantity)},
                )
            else:
                tracking_entry = stock_item.tracking_info.order_by('-date').first()

            movement = SaleTypeMovement.objects.create(
                tracking_entry=tracking_entry,
                part=stock_item.part,
                sale_type=sale_type,
                quantity=quantity,
                unit_value=unit_value,
                total_value=unit_value * quantity,
                customer=customer,
                notes=data.get('notes', ''),
                created_by=request.user,
            )

        return Response({'id': movement.id}, status=status.HTTP_201_CREATED)
```

- [ ] **Step 4: Wire up the URL in the plugin descriptor**

```python
# src/backend/InvenTree/plugins/stationery_sales/plugin.py — replace setup_urls
    def setup_urls(self):
        from django.urls import path

        from .api import RecordSaleView

        return [
            path('record-sale/', RecordSaleView.as_view(), name='record-sale'),
        ]
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `python3 manage.py test plugins.stationery_sales -v 2`
Expected: all tests PASS (model tests from Task 1 + API tests).

If `test_restock_increases_stock` fails because `add_stock()`'s own tracking entry isn't found by the `order_by('-date').first()` fallback — re-check `add_stock()`'s exact tracking-entry-creation call in `stock/models.py:3318-3371` (already read in full during planning) and adjust the fallback query if the ordering field differs from `date`.

- [ ] **Step 6: Commit**

```bash
git add src/backend/InvenTree/plugins/stationery_sales
git commit -m "feat: add atomic record-sale API endpoint for stationery_sales plugin"
```

---

## Self-Review Notes

- **Spec coverage:** Gap audit item #1 (sale-type dimension) — Task 1 (model) + Task 2 (atomic endpoint) together close it at the data-model level. Gift valuation (audit item #3) and B2B receivables (item #2) are explicitly **not** in this plan — they build on top of `SaleTypeMovement` in a follow-up plan, per the audit's suggested order.
- **No frontend work in this plan** — matches "focus first on business correctness... UI modernization is a separate phase" guidance from the earlier Next.js-side instructions, which applies here too. The API is usable via `curl`/Postman for now; a React panel comes later.
- **Type/interface consistency:** `SaleTypeMovement.SaleType` choices match the API's `sale_type` string values exactly (Django `TextChoices` — `.values` used directly in the API's validation).
- **Correction handling simplification flagged:** `correction` is currently only wired as inbound (`add_stock`) in this plan — a negative/outbound correction (shrinkage) isn't handled by Task 2's `OUTBOUND_TYPES` set. This mirrors a real gap: InvenTree's `StockHistoryCode.STOCK_COUNT` doesn't have a natural "reduce" pairing the way `add_stock`/`take_stock` do. Flagging this as a known limitation to resolve in Task 3 (or a dedicated correction-direction follow-up) rather than guessing at a design now — needs a decision on whether "correction" should take a `direction` parameter (in/out) same as the Next.js schema does, which this plan's `TRACKING_CODE_BY_SALE_TYPE`/`OUTBOUND_TYPES` split doesn't yet accommodate.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-19-sale-type-foundation.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
