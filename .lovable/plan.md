

## URL Key Audit Dashboard

Een nieuw component op de WooCommerce channel pagina dat een live overzicht toont van producten met gebroken `url_key` waarden, inclusief directe reparatie-acties.

### Wat wordt er gebouwd

Een "URL Key Audit" card op `/channels/woocommerce` die:

1. **Automatisch scant** op producten met `url_key = '-nvt'`, `null`, of leeg bij het selecteren van een tenant
2. **Overzicht toont** met:
   - Aantal gebroken URL keys per type (null, leeg, `-nvt`)
   - Tabel met getroffen producten (SKU, titel, huidige url_key, status-badge)
3. **Auto-repair knoppen**:
   - "Fix alle" knop die de bestaande `FIX_URL_KEYS` job aanmaakt
   - "Dry run" knop die de `fix-url-keys` functie direct aanroept met `dryRun: true` om een preview te tonen van wat er gerepareerd zou worden

### Technische details

**Nieuwe bestanden:**

| Bestand | Beschrijving |
|---------|-------------|
| `src/components/woocommerce/UrlKeyAudit.tsx` | Nieuw component met audit tabel en repair-acties |

**Aangepaste bestanden:**

| Bestand | Wijziging |
|---------|-----------|
| `src/pages/ChannelWooCommerce.tsx` | Import en tonen van `UrlKeyAudit` component met tenant doorgifte |

**UrlKeyAudit.tsx bevat:**
- Query op `products` tabel: `url_key = '-nvt'` OR `url_key IS NULL` OR `url_key = ''`
- Samenvatting-badges per type probleem
- Scrollbare tabel met kolommen: SKU, Titel, Huidige URL Key, Status
- "Dry Run" knop die `fix-url-keys` edge function aanroept met `dryRun: true` en resultaten inline toont
- "Auto-repair" knop die een `FIX_URL_KEYS` job insert (hergebruik van bestaande `createJob` logica)
- Resultaat-sectie die na dry run toont welke producten wel/niet gevonden zijn in WooCommerce

**Data flow:**

```text
Component mount + tenant geselecteerd
  -> SELECT products WHERE url_key IN ('-nvt', '', NULL)
  -> Toon tabel met gebroken producten

Dry Run klik
  -> supabase.functions.invoke('fix-url-keys', { tenantId, dryRun: true })
  -> Toon resultaten: "would fix" vs "not found in WooCommerce"

Auto-repair klik
  -> INSERT INTO jobs (type: 'FIX_URL_KEYS', payload: { tenantId })
  -> Toast + link naar Jobs pagina
```

