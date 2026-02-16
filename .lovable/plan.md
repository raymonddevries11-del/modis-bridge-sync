

## Scheduled Dry-Run Mode voor Bulk Fixes

Dit plan voegt een "scheduled dry-run" workflow toe: gebruikers kunnen een dry-run job inplannen via het jobs-systeem, het resultaat bekijken, en vervolgens met een klik de daadwerkelijke fix toepassen.

### Hoe het werkt

1. **Dry-run als job type**: Nieuw job type `DRY_RUN_FIX_URL_KEYS` dat de `fix-url-keys` functie aanroept met `dryRun: true`. Het resultaat wordt opgeslagen in het `payload`-veld van de job (als `dryRunResults`).

2. **Resultaat bekijken op Jobs pagina**: Jobs met type `DRY_RUN_*` krijgen een speciale weergave: een samenvatting van het dry-run resultaat (hoeveel "would fix", hoeveel "not found") en een "Toepassen" knop.

3. **Toepassen met een klik**: De "Toepassen" knop maakt een echte `FIX_URL_KEYS` job aan op basis van het dry-run resultaat, zodat de gebruiker exact weet wat er gaat gebeuren.

4. **UrlKeyAudit component uitbreiden**: De "Dry Run" knop krijgt een extra optie: "Plan als job" die een `DRY_RUN_FIX_URL_KEYS` job insert in plaats van direct de edge function aan te roepen.

### Wijzigingen per bestand

| Bestand | Wijziging |
|---------|-----------|
| `supabase/functions/job-scheduler/index.ts` | Nieuw case `DRY_RUN_FIX_URL_KEYS` dat `fix-url-keys` aanroept met `dryRun: true` in de payload |
| `supabase/functions/fix-url-keys/index.ts` | Dry-run resultaat opslaan in de job record wanneer `jobId` is meegegeven |
| `src/components/woocommerce/UrlKeyAudit.tsx` | Extra knop "Plan Dry Run" die een scheduled dry-run job aanmaakt |
| `src/pages/Jobs.tsx` | Dry-run resultaat weergave voor `DRY_RUN_*` jobs: samenvatting + "Toepassen" knop |

### Technische details

**job-scheduler/index.ts** -- nieuw case:
```text
case 'DRY_RUN_FIX_URL_KEYS':
  functionName = 'fix-url-keys';
  // payload bevat al dryRun: true (gezet bij insert)
  break;
```

**fix-url-keys/index.ts** -- resultaat opslaan in job:
Na het genereren van de resultaten, als `jobId` meegegeven is, het resultaat opslaan in de job:
```text
if (jobId) {
  await supabase.from('jobs').update({
    payload: { ...originalPayload, dryRunResults: results, dryRunSummary: { total, fixable: fixed, notFound, errors } }
  }).eq('id', jobId);
}
```

**UrlKeyAudit.tsx** -- nieuwe knop:
- "Plan Dry Run" knop die `jobs.insert({ type: 'DRY_RUN_FIX_URL_KEYS', payload: { tenantId, dryRun: true } })` doet
- Toast met link naar Jobs pagina

**Jobs.tsx** -- dry-run resultaat weergave:
- Voor jobs met type `DRY_RUN_FIX_URL_KEYS` en state `done`:
  - Toon samenvatting: "X fixbaar, Y niet gevonden, Z errors"
  - "Toepassen" knop die een `FIX_URL_KEYS` job insert met dezelfde `tenantId`
- Badge "DRY RUN" in een opvallende kleur naast het job type

### Flow

```text
Gebruiker klikt "Plan Dry Run"
  -> INSERT jobs: type=DRY_RUN_FIX_URL_KEYS, payload={tenantId, dryRun: true}
  -> job-scheduler pakt job op
  -> Roept fix-url-keys aan met dryRun=true
  -> Resultaat wordt opgeslagen in job.payload.dryRunResults
  -> Job state -> done

Gebruiker bekijkt Jobs pagina
  -> Ziet dry-run job met samenvatting
  -> Klikt "Toepassen"
  -> INSERT jobs: type=FIX_URL_KEYS, payload={tenantId}
  -> Daadwerkelijke fix wordt uitgevoerd
```

