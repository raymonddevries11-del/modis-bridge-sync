
## Bulk URL-Key Cleanup Job

Een nieuwe actie toevoegen aan de WooCommerce channel pagina waarmee je in een klik alle producten met foute `url_key` waarden kunt laten corrigeren via WooCommerce. Dit wordt geintegreerd in het bestaande jobs-systeem.

### Wat wordt er gebouwd

1. **Nieuwe job type: `FIX_URL_KEYS`** -- een job die de bestaande `fix-url-keys` edge function aanroept voor een tenant, zodat het asynchroon via de job queue verwerkt wordt.

2. **UI-knop op de WooCommerce pagina** -- een "Fix URL Keys" button op `/channel/woocommerce` die de job aanmaakt en voortgang toont.

3. **Job scheduler uitbreiding** -- het `FIX_URL_KEYS` job type wordt toegevoegd aan de `job-scheduler` edge function zodat het automatisch opgepakt wordt.

4. **Optioneel: volledige slug-sync knop** -- naast de "fix broken keys" ook een "Sync alle slugs" knop die de `sync-woo-slugs` functie via een job aanroept voor de hele catalogus.

---

### Technische details

**Bestanden die worden aangepast:**

| Bestand | Wijziging |
|---------|-----------|
| `src/pages/ChannelWooCommerce.tsx` | Nieuwe "Fix URL Keys" en "Sync Slugs" knoppen met tenant-selectie, loading state en resultaat-feedback |
| `supabase/functions/job-scheduler/index.ts` | Nieuw case `FIX_URL_KEYS` dat `fix-url-keys` aanroept, en `SYNC_WOO_SLUGS` dat `sync-woo-slugs` aanroept |
| `supabase/functions/fix-url-keys/index.ts` | Kleine aanpassing: accepteer ook `jobId` parameter zodat het in de job-flow past |

**Nieuwe job types:**

- `FIX_URL_KEYS` -- zoekt producten met `url_key = '-nvt'`, `null`, of leeg, en corrigeert ze via WooCommerce API lookup
- `SYNC_WOO_SLUGS` -- synchroniseert alle slugs paginagewijs (hergebruikt bestaande `sync-woo-slugs` functie)

**Flow:**

```text
Gebruiker klikt "Fix URL Keys"
  -> Insert in jobs tabel: type=FIX_URL_KEYS, state=ready, payload={tenantId}
  -> job-scheduler pikt job op
  -> Roept fix-url-keys edge function aan
  -> Resultaat wordt opgeslagen in job.result
  -> UI toont resultaat via realtime subscription (al aanwezig op Jobs pagina)
```

**ChannelWooCommerce.tsx wijzigingen:**
- Tenant selector toevoegen (hergebruikt `TenantSelector` component)
- "Fix URL Keys" knop die een job insert in de `jobs` tabel
- "Sync alle Slugs" knop die een `SYNC_WOO_SLUGS` job insert
- Toast feedback bij aanmaken van de job
- Link naar Jobs pagina voor voortgang

**job-scheduler/index.ts wijzigingen:**
- Toevoegen van twee nieuwe cases in de switch statement:
  - `case 'FIX_URL_KEYS': functionName = 'fix-url-keys';`
  - `case 'SYNC_WOO_SLUGS': functionName = 'sync-woo-slugs';`
