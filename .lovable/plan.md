

## Bron-overzicht, WooCommerce-mapping en "toevoegen in plaats van overschrijven"

Dit plan bevat drie onderdelen:

### 1. Bron-overzicht: Modis-data vs. WooCommerce-data

Op de Catalogus Data pagina (`/catalog-data`) worden twee nieuwe sub-tabs toegevoegd per sectie (attributen en categorieeen):

- **Bron (Modis)**: toont alle attributen/categorieeen zoals ze binnenkomen uit de Modis CSV-import (de huidige "in gebruik" data, gebaseerd op `field_sources` = `woocommerce-csv` of `modis`)
- **WooCommerce (gewenst)**: toont de gewenste attributen/categorieeen voor WooCommerce -- beheerd via een nieuwe database-tabel

### 2. Nieuwe tabel: `woo_category_mappings`

Een nieuwe database-tabel die Modis-broncategorieen koppelt aan gewenste WooCommerce-categorieen:

```text
woo_category_mappings
---------------------
id              uuid PK
tenant_id       uuid
source_category text       -- De categorie zoals die uit Modis binnenkomt
woo_category    text       -- De gewenste categorie in WooCommerce
created_at      timestamptz
updated_at      timestamptz
```

Met RLS-policies voor admin-beheer en authenticated-lezen.

### 3. UI voor matching

Op de Catalogus Data pagina komt per tab (Attributen / Categorieen) een extra sectie:

- **Categorieen-tab**: Een tabel met alle unieke Modis-broncategorieen links, en rechts een bewerkbaar dropdown/input-veld voor de gewenste WooCommerce-categorie. Ongematchte bronnen worden gemarkeerd met een waarschuwing. Bulk-actie om meerdere bronnen aan dezelfde WooCommerce-categorie te koppelen.

- **Attributen-tab**: Het bestaande `attribute_mappings`-systeem wordt hergebruikt. Er komt een visueel duidelijker onderscheid tussen "Modis bron" waarden en "WooCommerce doel" waarden.

### 4. WooCommerce sync: toevoegen in plaats van overschrijven

De `woocommerce-sync` edge function wordt aangepast:

**Huidige situatie (probleem):**
- Bij update wordt `updateData.categories = categoryIds.map(id => ({ id }))` gezet, wat de bestaande WooCommerce-categorieen volledig VERVANGT

**Nieuwe situatie:**
- Bij update worden de bestaande WooCommerce-categorieen eerst opgehaald (al beschikbaar via de `fetchAttrResponse`)
- De nieuwe categorieen worden SAMENGEVOEGD (merged) met de bestaande
- Duplicaten worden gefilterd op basis van category-ID
- Hetzelfde principe wordt toegepast op attributen

Daarnaast wordt de `woo_category_mappings` tabel geraadpleegd: als een broncategorie een mapping heeft, wordt de WooCommerce-categorie uit de mapping gebruikt in plaats van de broncategorie.

---

### Technische details

**Database migratie:**
- Nieuwe tabel `woo_category_mappings` met RLS-policies
- Unieke constraint op `(tenant_id, source_category)`

**Nieuwe/aangepaste bestanden:**

| Bestand | Wijziging |
|---------|-----------|
| `src/pages/CatalogData.tsx` | Extra tab-structuur voor Bron vs. WooCommerce view |
| `src/components/catalog/CategoryMappingManager.tsx` | NIEUW - UI voor bron-naar-WooCommerce mapping |
| `src/components/catalog/CategoryManager.tsx` | Bron-badge toevoegen per categorie |
| `src/hooks/useCategoryMappings.ts` | NIEUW - CRUD hook voor woo_category_mappings |
| `supabase/functions/woocommerce-sync/index.ts` | Categories MERGEN i.p.v. vervangen + mapping-lookup |

**Sync-logica wijziging (pseudocode):**

```text
// VOOR (huidige code):
updateData.categories = newCategoryIds.map(id => ({ id }))

// NA (nieuwe code):
1. Haal bestaande WooCommerce categories op (al beschikbaar)
2. Haal woo_category_mappings op voor tenant
3. Vertaal broncategorieen naar WooCommerce-categorieen via mappings
4. Merge: existingWooCats + newMappedCats (deduplicate op id)
5. updateData.categories = mergedCategoryIds.map(id => ({ id }))
```

