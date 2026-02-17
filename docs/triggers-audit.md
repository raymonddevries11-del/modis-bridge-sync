# Database Triggers — Audit & Reference

> Last updated: 2026-02-17

## Overview

This document catalogues all custom triggers attached to application tables,
their purpose, and the deduplication / backpressure mechanisms they use.

---

## Active Triggers

### `product_prices` table

| Trigger | Function | Event | Purpose |
|---|---|---|---|
| `trg_product_prices_sync` | `trigger_sync_product_prices()` | AFTER UPDATE | Creates a `SYNC_TO_WOO` job when `regular` or `list` price changes. Uses idempotent insert (`EXCEPTION WHEN unique_violation`) and backpressure (falls back to `pending_product_syncs` when queue ≥ 100). |

### `stock_totals` table

| Trigger | Function | Event | Purpose |
|---|---|---|---|
| `trg_stock_totals_sync` | `trigger_sync_stock_totals()` | AFTER UPDATE | Creates a `SYNC_TO_WOO` job when `qty` changes. Same idempotent insert + backpressure pattern as price trigger. |

### `products` table

| Trigger | Function | Event | Purpose |
|---|---|---|---|
| `trg_product_attributes_sync` | `trigger_sync_product_attributes()` | AFTER UPDATE | Detects changes to `images`, `categories`, or `attributes` columns. Writes to `pending_product_syncs` (not directly to `jobs`). |
| `update_products_updated_at` | `update_updated_at_column()` | BEFORE UPDATE | Auto-sets `updated_at = now()`. |

### `jobs` table

| Trigger | Function | Event | Purpose |
|---|---|---|---|
| `update_jobs_updated_at` | `update_updated_at_column()` | BEFORE UPDATE | Auto-sets `updated_at = now()`. |

### Other tables (timestamp only)

These tables have `update_updated_at_column()` triggers (BEFORE UPDATE):
- `attribute_definitions`
- `attribute_mappings`
- `google_category_mappings`
- `google_feed_config`
- `image_sync_status`
- `product_ai_content`

---

## Removed Triggers & Functions

| Item | Type | Table | Reason for removal |
|---|---|---|---|
| `queue_price_sync_trigger` | Trigger | `product_prices` | **Duplicate.** Redundant with `trg_product_prices_sync`. Removed 2026-02-17. |
| `queue_stock_sync_trigger` | Trigger | `stock_totals` | **Duplicate.** Redundant with `trg_stock_totals_sync`. Removed 2026-02-17. |
| `queue_price_sync()` | Function | — | Orphaned after trigger removal. Dropped 2026-02-17. |
| `queue_stock_sync()` | Function | — | Orphaned after trigger removal. Dropped 2026-02-17. |
| `track_product_change()` | Function | — | **Orphaned.** Never attached to a trigger. Logic fully covered by `trigger_sync_product_prices()` and `trigger_sync_stock_totals()`. Dropped 2026-02-17. |

---

## Single Source of Truth — Price & Stock Triggers

Each table has exactly **one** trigger handling sync job creation:

- **`product_prices`** → `trg_product_prices_sync` → `trigger_sync_product_prices()`
- **`stock_totals`** → `trg_stock_totals_sync` → `trigger_sync_stock_totals()`

Both follow an identical pattern:
1. **Change detection**: `OLD.field IS DISTINCT FROM NEW.field`
2. **Backpressure**: If queue ≥ 100, write to `pending_product_syncs` instead
3. **Idempotent insert**: `EXCEPTION WHEN unique_violation THEN NULL`

No other functions or triggers should write sync jobs for these tables.

---

## Deduplication Mechanisms

### 1. Payload Hash (unique index)
- Column: `jobs.payload_hash` — generated as `md5(type || ':' || payload::text)` (stored)
- Partial unique index `idx_jobs_dedupe` on `payload_hash` WHERE `state IN ('ready', 'processing')`
- Prevents two identical jobs from existing simultaneously

### 2. Idempotent Inserts (triggers)
- `trigger_sync_product_prices()` and `trigger_sync_stock_totals()` use:
  ```sql
  BEGIN
    INSERT INTO jobs (...) VALUES (...);
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  ```
- Silently skips if an identical job already exists

### 3. Backpressure (triggers)
- Both triggers check `COUNT(*) FROM jobs WHERE state IN ('ready', 'processing')`
- If queue ≥ 100, they write to `pending_product_syncs` instead of `jobs`
- `pending_product_syncs` uses `ON CONFLICT (product_id, reason) DO UPDATE SET created_at = now()` for natural dedup

### 4. Dedupe Utility Function
- `dedupe_sync_jobs()` — callable to manually clean duplicate ready SYNC_TO_WOO jobs (keeps oldest per payload_hash)

### 5. Housekeeping (pg_cron)
- `housekeep_jobs()` runs at 02:00 and 14:00 UTC
- Resets stuck processing jobs (>15min) to error
- Purges done jobs (>1 day) and error jobs (>7 days)

---

## Guidelines for Future Triggers

1. **Never create two triggers on the same table that write to `jobs`** — use a single trigger with comprehensive change detection
2. **Always use idempotent inserts** with `EXCEPTION WHEN unique_violation THEN NULL`
3. **Include backpressure** — check queue size before inserting into `jobs`; fall back to `pending_product_syncs`
4. **Use `pending_product_syncs`** for high-frequency changes (stock, price) — let the scheduler batch them
5. **Test with `SELECT * FROM pg_trigger WHERE tgrelid = 'table_name'::regclass`** to verify no duplicate triggers exist before adding new ones

---

## CI Guardrail

A GitHub Actions workflow (`.github/workflows/validate-triggers.yml`) runs automatically on any push or PR that modifies `supabase/migrations/`. It performs two checks:

1. **Static analysis**: Scans SQL files for `CREATE TRIGGER` + `INSERT INTO jobs` patterns and flags conflicts between migration files
2. **Runtime validation**: Calls `validate_no_duplicate_triggers()` DB function to verify no duplicates exist in the live database

The DB function `validate_no_duplicate_triggers()` detects:
- Tables with multiple triggers writing to `jobs` (`duplicate_job_writer`)
- Tables with multiple triggers writing to `pending_product_syncs` (`duplicate_pending_writer`)
- Triggers writing to `jobs` without idempotent insert (`missing_idempotent_insert`)

The companion `assert_no_trigger_violations()` raises an exception if any violations exist, usable in migration scripts:
```sql
-- Add at the end of any migration that creates triggers:
SELECT assert_no_trigger_violations();
```
