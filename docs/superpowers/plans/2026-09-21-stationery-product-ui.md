# Stationery Product UI — Design Specification

> **Status: DESIGN ONLY. No code touched.** This document defines the product/UX redesign of the functional UI checkpointed at `68ed4ba6e2`. That UI is the implementation foundation — this spec redesigns its visual/structural presentation, not its data model or API surface. Nothing under `src/frontend/` is modified by this document. No APIs added. No DB touched. No commit.

**Premise:** the backend is done (Sale-Type Foundation, B2B Receivables, Gift workflow, Reporting APIs) and the functional UI proved every screen works end-to-end. What's missing is a coherent *product* — right now it reads as "InvenTree with a few extra tabs." This spec turns it into a purpose-built Stationery Inventory & Sales Management System, built on InvenTree's engine but not looking like it.

---

## 1. Product UX Principles

Five decisions govern every screen below. When a later section seems to contradict InvenTree convention, it's because one of these took precedence:

1. **Business action first, database record second.** A customer is an account with a balance, not a Company row. An invoice is a document you act on, not a model instance you edit. Every primary screen leads with the action a shop employee actually came to do — the underlying InvenTree entity is a detail, not the headline.
2. **One clear primary action per screen.** InvenTree's pattern of a dense action toolbar (print/edit/duplicate/delete/barcode/...) is right for a power-user ERP and wrong here. Every stationery screen gets exactly one visually dominant action button; everything else is secondary or tucked behind a menu.
3. **Status is a color, not a sentence.** Paid/overdue/low-stock/gift states are communicated by badge color and position before the user reads a word — this is a shop-floor tool used between customers, not a back-office report read at leisure.
4. **Progressive disclosure, not hidden power.** Advanced InvenTree fields (barcodes, suppliers, BOM, stock history internals) are never deleted from the experience — they're one click further away, under "Advanced" or in the InvenTree-native page still linked from the stationery screen. Staff never see them by default; an admin can always reach them.
5. **Numbers a shop owner asks about daily get their own tile.** "How much did we sell today," "who owes us money," "what's low" — these are dashboard-tile questions, not report-page questions. Reports are for the monthly/period view; the dashboard is for the daily glance.

---

## 2. Navigation Architecture

### Evaluation of the proposed structure

The brief's proposed tree (Dashboard / Sales / Customers / Receivables / Inventory / Gifts / Reports / Settings) is directionally right but has two structural problems worth fixing before adopting it:

- **Customers and Receivables overlap.** A customer page without financial context is half a page; a receivables page without customer identity is a spreadsheet. Rather than two parallel top-level sections that both show "who owes what," Receivables becomes the *portfolio* view (all customers, aggregate) and the customer's own balance/invoices live *inside* their Customer Account page (§6). They cross-link heavily but aren't siblings competing for the same mental model.
- **Gifts as a top-level nav item overstates its frequency.** Gift-giving is a real, valued workflow but not a daily-use pillar like Sales/Customers/Inventory. It's promoted into the New Sale flow (§4, one of four transaction types) and gets its own **Reports** tab, but does not need permanent sidebar real estate competing with higher-frequency items. This directly reduces the "everyday ERP complexity" the brief asks to cut.

### Final navigation structure

```
[Logo]

  Dashboard

  Sales
    New Sale
    Sales History

  Customers                    (list + account pages; receivables data lives here too)

  Receivables                  (portfolio-wide: outstanding, aging, who owes what)

  Inventory
    Products
    Stock
    Restock

  Reports
    Sales
    Receivables
    Gifts

  ─────────────
  Advanced ▾              (collapsed by default, admin-oriented)
    Parts (InvenTree native)
    Stock Locations
    Purchasing
    Settings / Administration
```

Six primary items instead of eight. "Gifts" is reachable via New Sale (a transaction type, §4) and Reports (a tab, §11) — it doesn't need a seventh sidebar slot.

### Retained / hidden / replaced / advanced-only decisions

| InvenTree nav item | Decision | Why |
|---|---|---|
| Home/Dashboard | **Replaced** | New stationery dashboard (§3) is the landing page |
| Parts | **Advanced-only** | Product creation/editing is rare; day-to-day staff need "is this in stock and what's the price," covered by Inventory → Products (a simplified view, §9), not the full Part editor |
| Stock | **Retained, simplified** | Stock levels matter daily; the *screen* is simplified (§9), the underlying `StockItemTable` is reused |
| Manufacturing | **Already hidden** (pre-existing tenant customization, untouched by this spec) | Not applicable to a stationery retailer |
| Purchasing | **Advanced-only** | Supplier/PO management is an occasional admin task, not a staff workflow |
| Company (generic) | **Replaced** | Customers (§6) is the stationery-specific presentation of the same underlying `Company`/`CompanyDetail` data |
| Sales (InvenTree SalesOrder) | **Replaced for the stationery workflow** | `SalesIndex`/`SalesOrderDetail` model formal purchase orders with shipments/allocations — overkill for an over-the-counter sale. The stationery **Sales** section (New Sale + Sales History, §4/§5) becomes primary; the InvenTree Sales Order screens move under Advanced for the rare case a formal PO is actually needed |
| Users/Groups/Admin Center | **Advanced-only** | Settings/Administration, admin-only |
| Scan Barcode | **Retained, surfaced contextually** | Useful during New Sale product lookup (§4), not a standalone nav item for this tenant |

### Sidebar behavior

- **Icons + labels always visible on desktop** (≥ Mantine `md` breakpoint) — this is a low-navigation-depth app; icon-only collapse (InvenTree's current default-collapsed drawer pattern) adds a decode step new staff shouldn't need.
- **Active state**: filled background + left accent bar in the primary brand color (not just a text-weight change — needs to be glanceable from across a counter).
- **Advanced section**: collapsed `Accordion`-style group, closed by default, persisted per-user via existing `useLocalState` (the same mechanism InvenTree already uses for dashboard widget layout) so an admin who opens it once doesn't have to reopen it every session.
- **Mobile** (§13): sidebar becomes a bottom-sheet drawer triggered by a hamburger in the header, same `NavigationDrawer` component InvenTree already has — restyled (spacing/icons/grouping), not replaced.

---

## 3. Dashboard Design

### Layout decision (evaluating the brief's proposed layout)

The brief's three-tier layout (stat row → primary actions → secondary content) is correct and is what's specified below, with one refinement: **primary actions sit above the stat row, not between it and secondary content.** Reasoning: a shop employee's first action after opening the app is almost always "do a thing" (ring up a sale, take a payment), not "read a number." Actions get first-scan priority; the numbers confirm the action was worth taking. This also matches principle #2 (one dominant action) — leading with actions makes the hierarchy unambiguous immediately.

```
┌─────────────────────────────────────────────────────────┐
│  [New Sale]  [Receive Payment]  [Restock]                │  ← primary actions, large touch targets
├─────────────────────────────────────────────────────────┤
│  Today's Sales │ Outstanding │ Collected Today │ Low Stock│  ← 4 stat tiles
├─────────────────────────────────────────────────────────┤
│  Sales by Type (today)     │  Recent Transactions          │
│  (small bar/donut)         │  (last ~8, live)               │
├─────────────────────────────────────────────────────────┤
│  Outstanding Customers      │  Low-Stock Products            │
│  (top 5 by balance)         │  (top 5 by urgency)            │
└─────────────────────────────────────────────────────────┘
```

- **Stat tiles** (reuse `StatCard`, restyled per §12): Today's Sales (transaction_value from `reports/sales/` filtered to today), Outstanding (`reports/receivables/` total_outstanding), Collected Today (sum of payments with `payment_date = today` — **new computed value from existing data**, no new API needed since `invoices/<pk>/payments/` and the receivables report already carry payment amounts; computed client-side or via a tightly-scoped future backend addition, flagged in §18), Low Stock (count from InvenTree's existing low-stock stock query, reused as-is).
- **Primary actions**: `New Sale` opens the redesigned sale flow (§4) directly, no page navigation. `Receive Payment` opens a lightweight customer-search → payment modal (reuses `recordPaymentFields`, needs a small customer/invoice picker step not yet built — flagged in §18). `Restock` opens the Restock operational flow (§4/§9).
- **Sales by Type**: small horizontal bar or donut, 4 segments (B2B/Cash/Online — Gift excluded from *sales* since it's non-revenue, shown as its own small badge/tile instead per principle #3 not diluting the sales number). Purely visual summary, not interactive drill-down — clicking navigates to the full Sales Report (§11).
- **Recent Transactions**: last ~8 movements across all types, one line each: type badge, product, amount, time-ago. Click → relevant detail (invoice for B2B, nothing for cash/online since there's no detail page for those, just a toast-style "no further detail" — don't build a dead-end click target).
- **Outstanding Customers / Low-Stock Products**: two side-by-side mini-lists, top 5 each, "View all" links to Receivables and Inventory respectively.

### Empty/first-run state

New tenant with zero transactions: replace the two secondary-content rows with a single centered prompt — "No sales recorded yet" + the same `New Sale` button, so the dashboard never looks broken on day one.

---

## 4. Sales Workflow ("New Sale")

This is the single most important screen — it's used dozens of times a day by staff who may not be technical.

### Layout & hierarchy

```
┌─────────────────────────────────────────┐
│  New Sale                                │
│  ┌────────┐┌──────┐┌────────┐┌──────┐   │
│  │B2B     ││ Cash ││ Online ││ Gift │   │  ← segmented, large tap targets, icon+label
│  │Credit  ││      ││        ││      │   │
│  └────────┘└──────┘└────────┘└──────┘   │
│                                           │
│  [form area — changes per selection]     │
│                                           │
│  ─────────────────────────────────────   │
│              [Complete Sale]             │  ← single dominant submit button
└─────────────────────────────────────────┘
```

- **Type selector**: four large segmented buttons (not a `Menu` dropdown like the current implementation's `RecordSaleButton`) — this is the single most-used control in the app; it should never be hidden behind a click-to-reveal menu. Restock/Correction are **deliberately excluded from this selector** (see below).
- **Form area** changes based on selection, per the brief's field mapping:
  - **B2B Credit**: Customer (searchable typeahead, InvenTree's `RelatedModelField` restyled), Product, Quantity, Unit Price, Due Date (defaults to +30 days, shown but not demanded), Notes (collapsed under "Add note" toggle, not a visible field by default — reduces visual noise for the common case).
  - **Cash / Online**: Product, Quantity, Unit Price, optional Customer (collapsed under "Link to customer" toggle — most cash/online sales are walk-ins with no customer record).
  - **Gift**: Product, Quantity, Gift Value (labeled distinctly — "Value (for records)" not "Unit Price," reinforcing it's non-revenue; marked required with inline copy explaining why, matching the backend's enforced rule).
- **Product selection**: typeahead search-as-you-type against `stock/`, showing current stock level inline in the dropdown (so staff see "12 in stock" before they even submit) — this is new *client-side* behavior over existing data, not a new endpoint.
- **Live running total**: quantity × unit price shown live above the submit button, updates on every keystroke — closes the "did I enter that right" gap that a bare form leaves open.

### Restock / Correction — separate flow, not squeezed into this selector

Per the brief's own allowance ("use dedicated operational flows if that produces a clearer UX") — yes. Restock and Correction are not customer-facing sales; putting them in the same 4-button selector as B2B/Cash/Online/Gift implies they're the same *kind* of action to a first-time user, which they aren't (no customer, no revenue, purely an inventory-count operation). They live under **Inventory → Restock** (§9) as a distinct, simpler form (Product, Quantity, optional Note) — reusing the same backend endpoint (`record-sale/` with `sale_type=restock|correction`) but a UI that doesn't make a stock-clerk wade through a "customer type" decision that doesn't apply to them.

### Validation behavior

- Inline, per-field, on blur (not only on submit) — Mantine's existing form validation pattern, styled with the visual system's error color (§12).
- The running total (above) doubles as passive validation — an obviously-wrong quantity/price combination is visible before submit.
- Gift value required/positive is enforced client-side (matching the backend rule) with an inline hint, not a blocking modal — reduces friction while still preventing the common "forgot to set a value" mistake before the round-trip.

### Confirmation & success state

- **No confirmation modal before submit** — per principle #2, this is a high-frequency action; a "are you sure?" step on every single sale is exactly the ERP friction this redesign is meant to remove. The B2C/gift/restock backend operations are single-step and low-risk to redo if wrong; B2B (which creates an invoice) is the one case worth a half-second of friction, addressed by making the running total and customer name visible and legible right above the button rather than a separate confirm step.
- **On success**: a toast/notification (existing Mantine `notifications` system, already used elsewhere in InvenTree) — "Sale recorded — ₹500 · Acme Stationers" for B2B, "Sale recorded — ₹120" for cash/online, "Gift recorded — ₹80 value" for gifts — plus the form resets to blank (type selector stays on the last-used type, since staff often ring up several of the same type in a row) so the next sale can start immediately without navigating away.

### Error state

- Backend validation errors (insufficient stock, invalid customer, etc.) surface as inline field errors where the API response maps to a specific field, and as a dismissible banner above the form for whole-request errors (e.g. "insufficient stock for this movement") — never a blocking modal, matching the no-confirmation-friction principle above.

---

## 5. Sales History

### Purpose & hierarchy

Answers "what happened, when, to whom, how much, is it paid" at a glance — this is the historical counterpart to New Sale, and the two should feel like the same product (same type-badge visual language).

### Layout

- Single table (reuse `mantine-datatable` pattern from the current `InvoiceTable`, extended to cover all sale types, not just B2B invoices — **new client-side view over data already available**: needs a per-movement list, currently only reachable indirectly via reports; flagged in §18 as a small backend gap).
- Columns: **Type badge** (color-coded per §12), Product, Customer (— for non-B2B), Quantity, Value, **Status** (Paid/Outstanding for B2B, "—" for cash/online/gift, since those have no payment lifecycle), Date.
- Type badges use the same color coding as the dashboard's Sales-by-Type chart and the New Sale selector — one consistent color per type across the whole product, not re-invented per screen.
- **Filter row**: date range (matches the reports' `date_from`/`date_to` contract exactly, so the same date picker component works everywhere) + type filter (multi-select chips) + customer filter (typeahead, relevant only when a B2B/linked-customer filter is active).
- Internal InvenTree fields (tracking entry ID, raw sale_type_movement pk, part category internals) are never shown — only the business-relevant columns above.

### Responsive behavior

See §13 — this table collapses to a card-per-row layout below tablet width, since a 7-column table is unreadable on a phone.

---

## 6. Customer Experience

### Reframing: Customer Account, not Company record

The current implementation's Receivables *tab* bolted onto InvenTree's generic `CompanyDetail` page is functionally correct but visually still says "this is a Company database record with an extra tab." The redesign makes the financial relationship the headline, not a tab you have to click into.

### Information hierarchy

```
┌───────────────────────────────────────────┐
│  Acme Stationers                    [Edit] │  ← name is the title; edit is secondary/small
│                                             │
│  Outstanding: ₹12,400   Total Purchases: ₹85,000 │  ← headline stats, always visible
│  Invoices: 14           Last Payment: 3 days ago │
│                                             │
│  [New Sale]  [Receive Payment]             │  ← primary actions, same visual weight as dashboard's
├───────────────────────────────────────────┤
│  Overview │ Invoices │ Payments │ Transactions │  ← tabs
└───────────────────────────────────────────┘
```

- **Overview tab**: the stats above, plus a compact recent-activity list (last 5 invoices + last 5 payments interleaved by date) — answers "what's the state of this relationship" without clicking further.
- **Invoices tab**: reuses the existing `InvoiceTable` component as-is (already built, already correct) — filtered to this customer.
- **Payments tab**: a chronological payment ledger across *all* this customer's invoices (currently only viewable per-invoice) — **new client-side aggregation view**, no new endpoint needed (iterate the customer's invoices' payment histories), flagged as a minor implementation detail in §18.
- **Transactions tab**: all sale-type movements linked to this customer (mostly B2B, but a cash/online sale can optionally be linked per §4) — same table component as Sales History (§5), pre-filtered.
- **Non-customer companies** (suppliers/manufacturers, if any exist in this tenant's data): keep using InvenTree's native `CompanyDetail` — the redesigned Customer Account page only applies where `is_customer=true`, exactly matching the existing backend `Company.is_customer` distinction already used throughout the plugin (no new logic, just a UI fork on an existing flag).

---

## 7. Receivables

### Purpose

Portfolio-wide "who owes us money and how urgently" — the owner/admin's daily or weekly check-in screen. This is the redesigned presentation of the existing `reports/receivables/` data (§11 handles the periodic reporting angle; this section is the *operational workspace* for chasing payments right now).

### Layout

```
┌────────────────────────────────────────────┐
│ Total Outstanding │ Overdue │ Due Soon │ Customers w/ Balance │
├────────────────────────────────────────────┤
│ Customer          Outstanding  Oldest Due  Status  [Action]   │
│ Acme Stationers    ₹12,400     14 days      Overdue  [Collect]│
│ Beta Traders       ₹3,200      2 days       Due Soon [Collect]│
│ ...                                                           │
└────────────────────────────────────────────┘
```

- **Top stat row**: Total Outstanding, Overdue (sum where aging bucket ≠ current), Due Soon (1-30 bucket, reframed as "Due Soon" — friendlier business language than the aging-bucket internal naming), Customers with Balance (count).
- **Table**: one row per customer with outstanding > 0 (this is the aggregation `reports/receivables/`'s `by_customer` already provides — direct reuse, no new endpoint). Columns: Customer (name, links to Customer Account §6), Outstanding, Oldest Due Date, **Status badge** derived from the oldest invoice's aging bucket, **Collect** action button opening the Receive Payment flow pre-scoped to that customer.
- **Aging visual language** (answering the brief's "obvious without noisy" requirement): a single-color-dot + label per row (green "Current," amber "Due Soon," red "Overdue," dark-red "90+ days") rather than a 5-column aging-bucket breakdown per row — the detail-level aging breakdown (all 5 buckets) belongs in the Receivables *Report* (§11) where a monthly reviewer wants the full picture; the operational workspace only needs "is this one urgent, yes/no/how-urgent."
- Sort default: most-overdue first — surfaces the accounts needing attention without the user having to sort manually.

---

## 8. Invoice Experience

### Reframing: business document, not database record

```
┌────────────────────────────────────────┐
│ INV-0001              [Paid ✓]          │  ← reference + status badge, large
│ Acme Stationers                          │
│                                           │
│ Total: ₹5,000   Paid: ₹5,000  Outstanding: ₹0 │
│ Due: 2026-09-15                          │
├──────────────────────────────────────────┤
│ Items                                     │
│  Notebook A5 × 50 @ ₹100         ₹5,000  │
├──────────────────────────────────────────┤
│ Payment History                    [Record Payment] │
│  2026-09-10   ₹2,000   Cash              │
│  2026-09-14   ₹3,000   Online            │
└──────────────────────────────────────────┘
```

- Reference + status badge is the page title, not a breadcrumb detail — matches how an actual invoice document is read.
- Financial summary (Total/Paid/Outstanding/Due) is a stat row directly under the header, always visible without scrolling.
- **Record Payment** button lives next to the Payment History section header (contextually where the action belongs) rather than in a page-level toolbar — already correct in the current implementation, retained.

### Status → visual treatment

| Status | Badge color | Additional treatment |
|---|---|---|
| Unpaid | Red, filled | — |
| Partially Paid | Amber, filled | Outstanding amount emphasized (bold) in the stat row |
| Paid | Green, filled | Record Payment button disabled/hidden (already implemented) |
| Cancelled | Gray, outline | Entire page slightly de-emphasized (reduced-opacity content area), Record Payment disabled |
| Overdue (derived, not stored) | Red badge **additionally** shown next to Due Date specifically, separate from the status badge | Since "overdue" is a computed property layered on unpaid/partially_paid, not a 5th status — it needs its own visual signal distinct from the status badge so the two pieces of information (payment state vs. timeliness) aren't conflated into one badge |

---

## 9. Inventory Experience

### Audit finding

InvenTree's native `PartDetail`/`StockDetail`/`LocationDetail` pages carry dozens of fields (BOM, suppliers, manufacturer parts, stock history internals, barcode/QR data, pricing tiers, parameters, test results, variants) that are essentially irrelevant to a stationery retailer's daily operations. Rebuilding all of this would violate the brief's own "not all inventory internals" scope limit. The redesign is a **thin, opinionated view** in front of the existing data, not a parallel inventory system.

### Minimum staff-facing information (per the brief's explicit list)

Product, Stock Available, Price/Value, Low Stock flag, Recent Movement — nothing else, by default.

### Layout

- **Products** (list): reuses InvenTree's existing part table infrastructure (`InvenTreeTable`, since this list *is* a standard InvenTree paginated endpoint, unlike our plugin's custom lists) but with a **reduced default column set** (Name, Stock, Price, Low-Stock indicator) — advanced columns (category, supplier, barcode, etc.) available via the table's existing column-visibility toggle, just not shown by default. This is a configuration change to an existing component, not a new one.
- **Stock**: same treatment — `StockItemTable` reused, default columns trimmed to what's listed above, advanced fields available on toggle.
- **Restock**: the dedicated operational flow described in §4 — Product (typeahead), Quantity, optional Note, single "Add Stock" button. No customer, no unit-value-as-revenue framing (unit value is optional here, matching the backend's existing rule that only gifts require it).
- **Adjustments** (Correction sale type): same minimal form pattern as Restock, reusing `sale_type=correction`.
- **Advanced fields access**: every simplified list/detail keeps a persistent "Open in InvenTree" link/icon that routes to the native `PartDetail`/`StockDetail` page for admins who need the full picture — no functionality is removed, just not defaulted-to.

---

## 10. Gift Workflow

Already covered structurally in §4 (New Sale's fourth type) and §11 (its own report tab). No standalone "Gifts" screen beyond those two touchpoints — deliberately, per §2's navigation reasoning. A gift transaction, once recorded, shows up in Sales History (§5) with its distinct badge color like any other movement type; there's no separate gift-specific detail page since a gift has no lifecycle beyond the single recorded event (no invoice, no payment, nothing to revisit).

---

## 11. Reporting Experience

### Purpose

The brief distinguishes reporting (periodic, comparative) from the operational workspaces above (Receivables, Sales History) that answer "what's happening right now." Reports get **period framing and trend context** that the operational screens deliberately omit to stay fast/simple.

### Shared reporting shell

All three report pages (Sales/Receivables/Gifts) share one page shell: date-range picker (top, already implemented) + tab switcher between the three (already implemented as `ReportTabs`) + stat-tile row + one or two supporting tables/charts. This consistency is already achieved in the current implementation — retained wholesale, restyled per §12.

### Sales Report

- Stat tiles: Total Transactions, Total Quantity, Transaction Value, Collected Value (already implemented — retained).
- Breakdown table by type (B2B/Cash/Online — already implemented — retained).
- **New (design-only, not yet built)**: a simple period-over-period delta on the top-line Transaction Value stat tile (e.g. "↑ 12% vs. previous period" computed client-side by fetching the same date range shifted back) — genuinely useful for an owner reviewing performance, and achievable with the *existing* API by calling it twice with two date ranges, no backend change required. Flagged as a real but optional enhancement in §17's implementation order (not required for v1 of the redesign).

### Receivables Report

- Stat tiles: Total Invoiced, Collected, Outstanding, plus the 3 status counts (already implemented — retained).
- Aging table (already implemented — retained, this is where the full 5-bucket detail belongs, per §7's reasoning).
- Outstanding-by-customer table (already implemented — retained).

### Gifts Report

- Stat tiles: Gift Count, Total Quantity, Total Value (already implemented — retained).
- By-part breakdown table (already implemented — retained).
- Consider a simple horizontal bar for the by-part breakdown instead of a bare table once there are enough distinct gifted products to make a visual comparison useful — a nice-to-have, not required for v1.

**Explicitly not building**: a generic report/chart builder, cross-report correlation views, export/scheduling — matches the brief's "do not turn this into a generic BI application."

---

## 12. Visual Design System

### Color strategy

- **Brand/primary**: a single deliberate accent color (not InvenTree's default blue, to visually distinguish this as *the* stationery product rather than default-themed InvenTree) — exact hex deferred to whoever owns brand decisions (the existing "ITS" rebrand work already in the working tree, untouched by this spec, may already imply a direction — check that before finalizing rather than picking in a vacuum).
- **Status/semantic colors** (used consistently everywhere, never re-derived per screen):
  - Green = paid / current / healthy stock
  - Amber = partially paid / due soon / low stock warning
  - Red = unpaid / overdue / out of stock
  - Gray = cancelled / inactive / no data
- **Sale-type badge colors** (distinct from status colors, used in Sales History, New Sale selector, dashboard chart — one palette used everywhere):
  - B2B Credit — blue
  - Cash — green
  - Online — teal
  - Gift — purple/violet
  - Restock — gray/neutral (operational, not a sale)
  - Correction — gray/neutral, slightly different shade or icon from Restock to stay distinguishable

### Typography hierarchy

- Page titles: large, bold (Mantine `Title order={2}` equivalent) — one per screen, matches principle #2's single-focus idea.
- Stat tile values: largest text on any screen after the page title — these are the numbers a user's eye should land on first.
- Body/table text: standard Mantine default sizes, no custom scale needed — deviating here just for novelty adds inconsistency without benefit.
- Labels/captions (dates, secondary metadata): consistently smaller + `dimmed` color, never competing with primary content.

### Structural language

- **Border radius**: consistent `md` radius (Mantine default) on all cards/buttons/inputs — avoids the "some sharp, some rounded" inconsistency that reads as unpolished.
- **Card treatment**: `withBorder`, no heavy shadows — flat, professional, matches "practical business application" instruction (avoids the "marketing site" look explicitly warned against).
- **Table style**: `striped` + `highlightOnHover` (already used in the current implementation's tables) — retained, it's the right level of visual aid for scanning dense data without noise.
- **Spacing scale**: Mantine's default spacing tokens (`xs/sm/md/lg/xl`) used consistently — `md` between major sections, `sm` within a card/group. No custom spacing scale needed; inventing one adds a second system to keep in sync with Mantine's for no real benefit.
- **Button hierarchy**: exactly two tiers used consistently — filled (primary action, one per screen) and subtle/outline (everything else). No third "ghost" tier — three visually-different button weights is one too many for a fast-decision retail tool.
- **Badges**: solid-filled for status (payment/stock state — needs to be unambiguous at a glance), outline for classification (sale-type — informational, not urgent) — this distinction itself carries meaning (filled = "this needs your attention or tells you a state," outline = "this is a category label").

### Empty / loading / error states

- **Empty states**: icon + one-line message + the relevant primary action button (e.g. Sales History empty → "No sales yet" + `New Sale` button) — every empty state is an invitation to act, not a dead end. Already the right instinct in the dashboard's empty-state design (§3); apply the same pattern everywhere a list/table can be empty.
- **Loading states**: skeleton placeholders matching the eventual content's shape (already used for `CompanyDetail`'s details panel) — extend the same pattern to stat tiles (skeleton rectangles) and tables (skeleton rows) rather than a generic spinner, which tells the user nothing about what's coming.
- **Error states**: inline banners for recoverable/field-level errors (§4), never a full-page error unless the page's core data genuinely failed to load (e.g. invoice 404) — in which case a centered message + a way back (already implemented for the Invoice Detail 404 case), not a raw stack trace or blank page.
- **Modal behavior**: modals reserved for focused single-task actions (Record Sale, Record Payment) — never used for read-only detail viewing (which gets its own page/tab, per principle #1). Confirmation modals used sparingly, only for destructive/hard-to-reverse actions — explicitly *not* used for routine sale recording (§4).

---

## 13. Responsive Strategy

Per the architecture audit's finding: InvenTree core is desktop-first with almost no existing responsive patterns to lean on. This redesign defines responsive behavior fresh for the stationery screens, using Mantine's existing (underused) primitives — no new framework or breakpoint system.

| Screen | Desktop | Tablet | Mobile |
|---|---|---|---|
| Dashboard | 4-tile stat row, 2-col secondary content | 2×2 stat grid, secondary content stacks to 1 column | Stat tiles stack vertically (1 per row), primary actions become full-width stacked buttons |
| New Sale | Type selector as 4 inline segments, form in a single centered column | Same, form column narrows | Type selector becomes 2×2 grid (still large tap targets, just wrapped); form fields full-width stacked |
| Sales History | Full table, all columns | Table with 1-2 lower-priority columns hidden (e.g. raw date format simplified) | **Card-per-row transform**: each transaction becomes a compact card (type badge + product + value on one line, customer/date on a second line) — a 7-column table is unusable below ~600px, so this is a genuine layout change, not just column-hiding |
| Customer Account | Stats row + tabs side-by-side feel | Stats row wraps to 2×2 | Stats stack vertically; tabs become a horizontal scroll strip (Mantine `Tabs` already supports this) |
| Receivables | Full table | Table retains columns, row height increases slightly for touch | Card-per-row transform, same pattern as Sales History — Customer name + Outstanding prominent, aging dot inline, Collect button full-width within the card |
| Invoice Detail | Two-column feel (summary stats + line items/payments below) | Single column, stats row wraps to 2×2 | Single column throughout, stat tiles stack, tables within (line items, payment history) get horizontal scroll containers (already implemented via `Table.ScrollContainer`) rather than card-transforms, since these are naturally small/short tables where scroll is acceptable |
| Reports | Stat row + tables side-by-side where space allows | Stats wrap, tables stack | Stats stack vertically, tables get horizontal scroll (already implemented pattern), date picker fields stack instead of sitting inline |

General rule for **when to card-transform vs. horizontal-scroll**: tables a user needs to *scan many rows of* (Sales History, Receivables) get the card transform, because horizontal scrolling defeats fast scanning; tables that are typically short and read top-to-bottom once (Invoice line items, Payment history, Report breakdown tables) keep horizontal scroll, because a card transform for a 3-row table is unnecessary complexity.

Breakpoints: reuse Mantine's existing custom breakpoints already defined in `ThemeContext.tsx` (`xs: 30em, sm: 48em, md: 64em, lg: 74em`) rather than inventing new ones — "tablet" in the table above maps to `sm`–`md`, "mobile" to below `xs`/`sm`.

---

## 14. Component Strategy

| Component need | Decision |
|---|---|
| Data tables (Sales History, Receivables, Reports breakdowns) | **Reuse** `mantine-datatable`'s `DataTable` directly, as already established in the current implementation (`InvoiceTable`, `PaymentHistoryTable`) — this is the right call already made; extend the same pattern to new tables rather than introducing anything else |
| InvenTree-native lists (Products, Stock) | **Reuse** `InvenTreeTable` as-is, with restyled/reduced default columns (a configuration change, not a new component) |
| Forms (New Sale, Record Payment, Restock) | **Reuse** `ApiForm`/`useCreateApiFormModal` infrastructure and the existing hand-written field-set pattern (`StationeryForms.tsx`) — **restyle**, not replace: the redesigned New Sale screen (§4) needs a new *layout* wrapper (segmented type selector, live running total) around the same underlying form-field/validation machinery |
| Stat tiles | **Restyle** the existing `StatCard` component — add the visual system's typography/spacing decisions (§12), no structural change needed |
| Status/type badges | **Restyle** the existing `InvoiceStatusBadge`/`AgingBadge` pattern, extend with new sale-type badges (§12's color table) — same component family, more variants |
| Navigation | **Restyle** `NavigationDrawer`/`links.tsx` structure per §2 — reuses the existing nav-config pattern (array of `{name, title, icon, link}`), just a different set of entries and an added "Advanced" collapsible group (new small component, since InvenTree's nav has no existing collapsible-section pattern to reuse) |
| Charts (Sales-by-type mini chart, dashboard) | **New, minimal**: a small bar/donut — check for an existing charting library already in the dependency tree (InvenTree uses some charting for its own stock-history views) before adding one; if one exists, reuse it, if not, a lightweight option is justified for 1-2 simple summary charts — this is the one area worth a brief dependency-audit step at implementation time (§18), not decided here |
| Date range filter | **Reuse** the existing `ReportDateRangeFilter` as-is — already exactly right, extend its use to Sales History's date filter too |
| Product/customer typeahead in New Sale | **Reuse** the existing `related field` machinery (`RelatedModelField`, already used for `stock_item_id`/`customer_id` in `StationeryForms.tsx`) — the "shows stock level inline in the dropdown" enhancement (§4) is a rendering customization (`modelRenderer` prop, already part of `ApiFormFieldType`) on top of the existing component, not a new one |

**Explicitly not introducing**: a second component library, a new state-management layer, a custom design-token system separate from Mantine's theme, or a parallel form framework. Every "new" component above is either a thin composition of existing pieces or a small, genuinely-missing primitive (collapsible nav group, chart).

---

## 15. Existing InvenTree Functionality — Hide / De-emphasize Map

| Functionality | Treatment | Where it still lives |
|---|---|---|
| Manufacturing/BOM | Already hidden (pre-existing tenant work, untouched) | N/A for this tenant |
| Formal Sales Orders (shipments, allocations, line-item progress) | De-emphasized — not in primary nav | Advanced section |
| Purchasing (suppliers, PO, manufacturer parts) | De-emphasized | Advanced section |
| Part editor (full field set: BOM, variants, parameters, test templates) | De-emphasized as default view | "Open in InvenTree" link from simplified Products list |
| Stock item internals (serials, batches, ownership, full tracking history) | De-emphasized as default view | "Open in InvenTree" link from simplified Stock list |
| Barcode scanning | Retained but contextual, not a standalone nav item | Surfaced inside New Sale's product picker |
| Users/Groups/Admin Center, System Settings | Admin-only | Advanced section |
| Company records for non-customers (suppliers/manufacturers) | Retained as-is (native `CompanyDetail`) | Reached via Purchasing (Advanced), not the redesigned Customers section |
| Return Orders | De-emphasized (no stationery-specific workflow defined; out of this spec's scope) | Advanced section, flagged as an open question in §19 if actually used by this business |

---

## 16. Role-Based Future Visibility (documented, not implemented)

Per instruction: no role restrictions implemented now; backend `IsAuthenticated`-only remains authoritative. This table documents *where* a future backend permission decision would map to a frontend visibility change, so that work is a lookup, not a redesign, when it happens.

| Area | Owner/Admin | Staff | Notes |
|---|---|---|---|
| Dashboard | Full (all stats) | Full, or a reduced stat set (e.g. hide period-over-period trend, keep today's numbers) | Genuinely optional — even full visibility for staff may be fine; flag for actual product-owner decision, not assumed here |
| New Sale (all 4 types) | Full | Full — this is a core staff task | No restriction anticipated |
| Sales History | Full, all customers | Full — staff need this for "did I already ring this up" lookups | No restriction anticipated |
| Customers | Full, incl. financial stats | Full read access likely needed (staff serve customers); **edit** (e.g. changing a customer record) plausibly admin-only | Maps to existing `hasChangePermission` pattern already in InvenTree's permission model |
| Receivables (portfolio workspace) | Full | Possibly hidden or read-only — "who owes us money in aggregate" is more of an owner concern than a staff task | Candidate for the first real role restriction if one is added |
| Invoice Detail | Full, incl. Record Payment | Record Payment likely fine for staff (they're the ones taking payment at the counter); cancelling an invoice plausibly admin-only | Maps to a future `can_cancel_invoice`-style permission, not yet backed by any API |
| Inventory (Products/Stock, simplified view) | Full | Full — staff need stock visibility to sell accurately | No restriction anticipated |
| Restock | Full | Full — staff often the ones physically restocking | No restriction anticipated |
| Reports (all 3) | Full | Candidate for admin-only — reports are an owner/business-performance concern more than a staff task | Second candidate for role restriction |
| Advanced section | Full | Hidden entirely | Matches `user.isStaff()`-style checks InvenTree already uses for its own Settings/Admin nav items — same mechanism, just applied to this section as a whole |

**No implementation implied by this table** — it exists purely so a future "add role restrictions" task has a ready-made map instead of re-deriving one.

---

## 17. Screen-by-Screen Implementation Order

Ordered by (a) daily-use frequency and (b) how much of the redesign is genuinely new UI vs. restyling already-correct components — front-loading the highest-value, lowest-risk work:

1. **Visual system foundation** (§12) — color tokens, badge component variants, typography — touches every other screen, must land first so nothing is restyled twice.
2. **Navigation restructure** (§2) — sidebar entries, Advanced collapsible group — unblocks reaching every other redesigned screen.
3. **New Sale redesign** (§4) — highest daily-use screen, currently the biggest gap between "functional" and "product."
4. **Dashboard redesign** (§3) — first-impression screen, mostly composition of stat tiles + existing data, moderate new work (charts).
5. **Sales History** (new screen, §5) — currently doesn't exist as a unified view (only reachable via reports); meaningful net-new value.
6. **Customer Account redesign** (§6) — restyle + one new tab (Payments ledger aggregation).
7. **Receivables workspace redesign** (§7) — restyle of existing data into a new operational layout.
8. **Invoice Detail redesign** (§8) — smallest visual delta from current implementation, mostly status-color refinement.
9. **Inventory simplification** (§9) — column-visibility configuration changes, lowest implementation risk.
10. **Reports polish** (§11) — mostly retained as-is; period-comparison enhancement is optional/last.

---

## 18. Data/API Dependencies

Every screen above is buildable on **existing** APIs except the following, called out explicitly rather than assumed:

| New client-side need | Backed by existing API? | Note |
|---|---|---|
| Sales History (all movement types, unified) | **Gap** — no `GET /plugin/stationerysales/movements/` list exists (only reports aggregate, and B2B invoices list individual rows). Needs a small new read-only endpoint, same shape/spirit as `invoices/` list, **not built in this design phase** | Flag for a future backend-prerequisite phase, same pattern as the Phase 0 invoice-list addition before the last UI build |
| Customer Payments ledger tab (§6) | Yes, client-side aggregation | Iterate the customer's invoices (`customers/<pk>/receivables/` gives the invoice list) and fetch each invoice's payments — no new endpoint, just more client-side composition |
| Dashboard "Collected Today" tile | Yes, computable | Sum `reports/receivables/` isn't quite right (portfolio total, not "today"); more precisely: sum payments with `payment_date = today` across all invoices — same gap as Sales History (needs a list of payments, not just per-invoice), so this tile depends on resolving the same gap above |
| Receive Payment flow (dashboard/Receivables quick action) | Yes | Needs a customer/invoice picker step before landing on the existing `recordPaymentFields()` form — a new small UI flow over existing endpoints, no new API |
| Sales Report period-over-period comparison | Yes | Two calls to the existing `reports/sales/` endpoint with shifted date ranges — no backend change |

**Everything else** — New Sale, Invoice Detail, Receivables portfolio table, Customer Overview/Invoices/Transactions tabs, all 3 Reports, Inventory — maps directly onto APIs that already exist and were verified working in the prior implementation phase.

---

## 19. Testing Strategy

- **Visual/component-level**: no existing frontend test suite convention was found in the prior architecture audit — before implementation, check for Vitest/Playwright/Storybook setup rather than assuming none exists (same caveat carried over from the earlier UI audit).
- **Functional verification**: same pattern successfully used throughout the backend work — live smoke testing against the real dev server with disposable `SMOKETEST-` data, plus `tsc --noEmit` and `yarn build` clean runs (both already proven clean for the current implementation and should remain the bar for the redesign).
- **Manual browser verification is required and was not possible in the prior implementation phase** (no browser automation tool was available) — flagging this again here since it's the one real gap in confidence about anything actually *looking* right; strongly recommend a manual click-through pass (by a human, or via `claude-in-chrome` if enabled for a future session) before treating any redesigned screen as done, not just relying on clean builds.
- **Responsive verification**: manual resize-and-check at the three breakpoints defined in §13, specifically the card-transform tables (Sales History, Receivables) since those are genuine layout changes, not just CSS reflow, and are the most likely place for a subtle bug to hide.
- **Regression**: every existing backend smoke-test matrix (Sale-Type Foundation, B2B Receivables, Gift, Reporting — all previously verified) remains the ground truth for correctness; this redesign changes presentation only, so a redesign that breaks any of those underlying flows is a bug, not a design tradeoff.

---

## Open questions for you (not decided unilaterally here)

1. **Brand color** — should reference the existing "ITS" rebrand work already sitting in the working tree rather than being picked fresh; I didn't reopen that file to avoid touching it during a code-free design phase, but it should inform §12 before implementation.
2. **Return Orders** (§15) — genuinely used by this business, or safe to fully de-emphasize? Not enough signal in prior work to decide.
3. **Charting library** (§14) — worth a 10-minute dependency check before implementation to see if InvenTree already ships one usable for the two small charts proposed (Sales-by-type, dashboard).
4. **Sales History / Collected-Today gap** (§18) — the one real backend prerequisite this redesign surfaces (a movements-list endpoint). Confirm whether that's worth a small Phase-0-style backend addition before UI work starts, same as was done for the invoice-list endpoint.
