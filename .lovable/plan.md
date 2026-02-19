

# PIM-to-WooCommerce Sync Refactoring - Implementatieplan

Dit plan vertaalt het verbeteringsvoorstel naar concrete wijzigingen, aangepast aan het bestaande schema (UUID-based IDs, bestaande `jobs` tabel met `job_state` enum, etc.).

---

## Fase 1: Database Schema Migraties

### 1a. `pending_product_syncs` herstructureren

Huidige structuur: `PK(product_id, reason)`, kolommen: `product_id, tenant_id, reason, created_at`

Wijzigingen:
- Nieuwe kolommen: `sync_scope`, `priority`, `status`, `attempts`, `next_retry_at`, `last_seen_at`, `locked_at`, `locked_by`, `payload_hint`
- Nieuwe UNIQUE constraint: `(tenant_id, product_id, sync_scope)`
- Oude PK `(product_id, reason)` moet vervangen worden -- dit vereist een drop+re-create of een migratiestrategie
- Nieuwe PK op auto-increment `id` kolom (of `gen_random_uuid()`)
- Indexes voor picking en retry

Migratieaanpak:
1. Huidige pending rows verwijderen (tabel is transient, geen verlies)
2. Tabel droppen en opnieuw aanmaken met juiste structuur
3. Of: kolommen toevoegen, constraint wijzigen (complexer maar zero-downtime)

Gekozen aanpak: DROP + CREATE (tabel bevat alleen kortstondige queue-items, na drain zijn ze weg).

### 1b. `product_sync_status` uitbreiden

Huidige structuur: `PK(product_id)`, kolommen: `product_id, last_synced_at, sync_count, created_at`

Toevoegen:
- `tenant_id` (UUID, NOT NULL) -- nodig voor tenant-scoped queries
- `last_synced_at_price_stock`, `last_synced_at_content`, `last_synced_at_taxonomy`, `last_synced_at_media`, `last_synced_at_variations` (TIMESTAMPTZ)
- `last_error`, `last_error_at`

### 1c. `products` tabel uitbreiden

Toevoegen:
- `woocommerce_product_id` (BIGINT, nullable) -- directe WC mapping
- `woo_permalink`, `woo_slug`, `woo_main_image_url` (TEXT, nullable)
- `dirty_price_stock`, `dirty_content`, `dirty_taxonomy`, `dirty_media`, `dirty_variations` (BOOLEAN, default false)
- `updated_at_price_stock`, `updated_at_content`, `updated_at_taxonomy`, `updated_at_media`, `updated_at_variations` (TIMESTAMPTZ)
- Index op `(tenant_id) WHERE woocommerce_product_id IS NULL`

### 1d. `jobs` tabel uitbreiden

Toevoegen:
- `scope` (TEXT, nullable) -- PRICE_STOCK, CONTENT, TAXONOMY, MEDIA, VARIATIONS
- `priority` (INT, default 50)
- `next_run_at` (TIMESTAMPTZ, default now())
- `locked_at`, `locked_by` (voor claim-based locking)
- Index op `(state, next_run_at, priority)`

### 1e. Nieuwe tabel: `rate_limit_state`

Kolommen:
- `tenant_id` (UUID, PK)
- `tokens` (NUMERIC, default 20)
- `capacity` (INT, default 20)
- `refill_per_minute` (INT, default 20)
- `penalty_factor` (NUMERIC, default 1.0)
- `cooldown_until` (TIMESTAMPTZ, nullable)
- `last_refill_at`, `updated_at` (TIMESTAMPTZ)

Initialiseren voor bestaande tenants.

### 1f. Nieuwe tabel: `sync_log` (optioneel, audit)

Kolommen: `id, tenant_id, job_id, product_id, scope, request_hash, request_body, response_status, response_body, duration_ms, created_at`

RLS: service role full access, authenticated read.

---

## Fase 2: Database Triggers Aanpassen

### 2a. `trigger_sync_product_prices()` herschrijven

Huidige logica: bij prijs wijziging -> upsert `pending_product_syncs` met `reason='price'`

Nieuwe logica:
- Upsert met `sync_scope='PRICE_STOCK'`, `priority=100`
- ON CONFLICT `(tenant_id, product_id, sync_scope)` -> update `last_seen_at`, reset `status` naar `PENDING`
- Update `products` SET `dirty_price_stock=true`, `updated_at_price_stock=now()`

### 2b. `trigger_sync_stock_totals()` herschrijven

Zelfde patroon als prijzen: `sync_scope='PRICE_STOCK'`, `priority=100`
- Update `products` SET `dirty_price_stock=true`, `updated_at_price_stock=now()`

### 2c. `trigger_sync_product_attributes()` herschrijven

Huidige logica: detecteert images/categories/attributes wijziging -> upsert met `reason`

Nieuwe logica per wijzigingstype:
- `images` changed -> `sync_scope='MEDIA'`, `priority=40`, `dirty_media=true`
- `categories` changed -> `sync_scope='TAXONOMY'`, `priority=50`, `dirty_taxonomy=true`
- `attributes` changed -> `sync_scope='CONTENT'`, `priority=60`, `dirty_content=true`
- Elk met bijbehorende `updated_at_{scope}=now()` op `products`

---

## Fase 3: Edge Functions Refactoren

### 3a. `drain-pending-syncs/index.ts`

Huidige logica: pakt pending rows, groepeert per tenant, maakt SYNC_TO_WOO jobs in batches van 50.

Nieuwe logica:
1. Query pending rows `WHERE status='PENDING'` en `last_seen_at <= cutoff`, ORDER BY `priority DESC, last_seen_at ASC`
2. Groepeer per `(tenant_id, sync_scope)`
3. Batch sizes per scope:
   - `PRICE_STOCK`: 50-100
   - `CONTENT`/`TAXONOMY`: 20-50
   - `MEDIA`/`VARIATIONS`: 5-15
4. Check `rate_limit_state` per tenant -- skip als `cooldown_until > now()` of `tokens <= 0`
5. Maak jobs met `scope` en `priority` in payload en op job-rij
6. Markeer pending rows als `DONE` of verwijder ze

### 3b. `job-scheduler/index.ts`

Wijzigingen:
1. **Priority ordering**: `ORDER BY priority DESC, next_run_at ASC, created_at ASC`
2. **Tenant fairness**: max 2 gelijktijdige jobs per tenant (round-robin selectie)
3. **Rate limit check**: voor elke job execution, check `rate_limit_state` tokens
4. **Bij 429/503**: call `rate_limit_penalize(tenant)` -- halveer tokens, set cooldown
5. **Bij succes**: call `rate_limit_success(tenant)` -- geleidelijk penalty_factor herstellen
6. **Idempotency**: worker checkt `updated_at_{scope} > last_synced_at_{scope}` per product, skipt als niet nodig

### 3c. `push-to-woocommerce/index.ts` (of `woocommerce-sync/index.ts`)

Scope-aware payload:
- Lees `syncScope` uit job payload
- `PRICE_STOCK`: push alleen `regular_price`, `sale_price`, `stock_quantity`, `manage_stock`, `stock_status`
- `CONTENT`: push alleen `name`, `description`, `short_description`, `meta_data`
- `TAXONOMY`: push alleen `categories`, `attributes` (global)
- `MEDIA`: push alleen `images` (WordPress Media upload)
- Geen scope / `FULL`: backward compatible, pusht alles

Na succes:
- Update `product_sync_status.last_synced_at_{scope}`
- Clear `products.dirty_{scope}`
- Geen read-back GET (vertrouw WC response)
- Update `products.woocommerce_product_id`, `woo_permalink`, `woo_slug` bij creates

Bij media fout:
- Laat rest van job slagen
- Enqueue nieuw `MEDIA` pending item voor dit product

### 3d. `sync-new-products/index.ts`

Wijziging:
- Query: `products WHERE woocommerce_product_id IS NULL` (i.p.v. cache-vergelijking)
- Na create: update `products` met `woocommerce_product_id`, `woo_permalink`, `woo_slug`
- Bij image upload fout: maak apart `MEDIA` pending item

### 3e. `daily-bulk-sync/index.ts`

Wijziging:
- Wordt "repair mode": zet dirty flags voor alle producten van een tenant
- Niet meer automatisch dagelijks -- handmatig triggerbaar via UI
- Of: alleen producten waar `updated_at > last_synced_at` (verify-only)

### 3f. Rate limit helper functies

Nieuwe utility functies (in edge functions):
- `rateLimitAllow(supabase, tenantId)`: refill tokens, check availability, decrement
- `rateLimitPenalize(supabase, tenantId)`: penalty_factor x2, set cooldown 30-60s
- `rateLimitSuccess(supabase, tenantId)`: geleidelijk penalty_factor herstellen naar 1.0

---

## Fase 4: Cron Jobs Aanpassen

Via SQL (insert tool):

| Cron job | Actie |
|----------|-------|
| `daily-full-product-sync` (03:00) | Verwijderen of uitschakelen |
| `drain-pending-syncs-every-minute` | Behouden, ongewijzigd schema |
| `process-job-queue` (elke minuut) | Behouden |
| `sync-new-products-hourly` | Behouden |
| `sync-watchdog-every-10-min` | Behouden |

---

## Fase 5: Volgorde van Implementatie

Elke fase is onafhankelijk deploybaar:

1. **Migratie 1**: Schema uitbreidingen (kolommen toevoegen, tabellen maken) -- geen breaking changes
2. **Migratie 2**: Triggers herschrijven -- schrijven nu `sync_scope`; oude `reason` waarden worden niet meer aangemaakt
3. **Deploy**: `drain-pending-syncs` refactor -- verwerkt nieuwe format, backward compatible met eventuele oude rows
4. **Deploy**: `push-to-woocommerce` / `woocommerce-sync` scope-aware -- zonder scope in payload doet full sync
5. **Deploy**: `job-scheduler` fairness + rate limiting
6. **SQL**: Cron jobs aanpassen (daily-bulk-sync uitschakelen)
7. **Deploy**: `sync-new-products` aanpassen (woocommerce_product_id check)

---

## Risico's

- **Backward compatible**: alle schema wijzigingen zijn additief (ADD COLUMN, nieuwe tabellen). Bestaande jobs zonder `scope` worden als FULL behandeld.
- **pending_product_syncs PK wijziging**: vereist DROP+CREATE. Drain eerst alle pending items.
- **Geen downtime**: migraties zijn non-blocking ALTER TABLE ADD COLUMN met defaults.

---

## Bestanden die wijzigen

| Bestand | Wijziging |
|---------|-----------|
| SQL migratie(s) | Schema uitbreidingen + nieuwe tabellen |
| Trigger functies (SQL) | 3 triggers herschrijven |
| `supabase/functions/drain-pending-syncs/index.ts` | Scope-aware batching + rate limit |
| `supabase/functions/job-scheduler/index.ts` | Priority, fairness, rate limiting |
| `supabase/functions/push-to-woocommerce/index.ts` | Scope-aware payload |
| `supabase/functions/woocommerce-sync/index.ts` | Scope-aware payload |
| `supabase/functions/sync-new-products/index.ts` | woocommerce_product_id check |
| `supabase/functions/daily-bulk-sync/index.ts` | Repair-only mode |
| Cron jobs (SQL) | daily-full-product-sync uitschakelen |

### Bestanden die NIET wijzigen:
- Frontend componenten (behalve optioneel repair-knop)
- `batch-woo-sync/index.ts`, `sync-watchdog/index.ts`
- `supabase/config.toml`, `client.ts`, `types.ts`

