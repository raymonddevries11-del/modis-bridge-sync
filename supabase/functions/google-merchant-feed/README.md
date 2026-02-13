# Google Merchant Feed – API & Schema Documentatie

## Endpoint

```
GET /functions/v1/google-merchant-feed?tenantId={uuid}
POST /functions/v1/google-merchant-feed  (body: { "tenantId": "uuid" })
```

Returns: `application/xml` (RSS 2.0 met Google Shopping namespace)

## Velden per item

| Google-veld | Bron | Verplicht | Opmerking |
|---|---|---|---|
| `g:id` | `{sku}-{maat_id}` | ✅ | Uniek per variant |
| `g:title` | AI-titel → formula titel | ✅ | Max 150 tekens |
| `g:description` | AI-beschrijving → webshop_text → meta_description | ✅ | |
| `g:link` | `url_key` → slugified title | ✅ | |
| `g:image_link` | `images[0]` | ✅ | Items zonder afbeelding worden overgeslagen |
| `g:additional_image_link` | `images[1..9]` | ❌ | Max 10 afbeeldingen |
| `g:availability` | `stock_totals.qty` | ✅ | `in_stock` / `out_of_stock` |
| `g:price` | `product_prices.regular` | ✅ | Producten met prijs ≤ 0 worden overgeslagen |
| `g:sale_price` | `product_prices.list` | ❌ | Alleen als list < regular |
| `g:brand` | `brands.name` | ✅ | |
| `g:condition` | category mapping → `new` | ✅ | |
| `g:google_product_category` | `google_category_mappings` → fallback | ✅ | GPC taxonomie |
| `g:gtin` | `variants.ean` | ❌ | `identifier_exists=false` als leeg |
| `g:size` | `variants.maat_web` → `size_label` | ❌ | |
| `g:size_system` | Hardcoded `EU` | ❌ | Altijd EU voor alle producten |
| `g:color` | Zie kleur-logica hieronder | ❌ | Fallback "Meerkleur" voor kleding |
| `g:gender` | category mapping → fallback config | ❌ | |
| `g:age_group` | category mapping → fallback config | ❌ | |
| `g:material` | category mapping → `attributes.Materiaal` | ❌ | "Overige"/"NVT" gefilterd |
| `g:product_type` | `article_group` → `categories[0]` | ❌ | |
| `g:item_group_id` | `products.sku` | ✅ | Koppelt varianten samen |
| `g:product_highlight` | `product_ai_content.ai_features` | ❌ | Max 5, alleen eerste variant |
| `g:shipping` | `google_feed_config.shipping_rules` | ❌ | Per land |
| `g:excluded_destination` | Gevoelige termen detectie | ❌ | Orthopedische producten |

## Size System

**Waarde:** `EU` (hardcoded)

Alle producten gebruiken het Europese matensysteem. Het `<g:size_system>EU</g:size_system>` veld wordt automatisch toegevoegd aan elk item dat een maat (`g:size`) bevat.

Ondersteunde waarden door Google: `AU`, `BR`, `CN`, `DE`, `EU`, `FR`, `IT`, `JP`, `MEX`, `UK`, `US`.

Huidige implementatie: niet configureerbaar per tenant of product — altijd EU.

## Kleur-logica

Prioriteit:
1. `color.webshop` (als niet "Meerkleur")
2. `color.article` (opgesplitst op `-`, "combi" gestript)
3. `color.label` / `color.name`
4. `attributes.Kleur`
5. Fallback: `Meerkleur` (alleen voor Apparel/Accessories categorieën)

Ongeldige waarden gefilterd: `NVT`, `N/A`, `geen`, `-`

Samengestelde kleuren worden in Google-formaat gezet: max 3 waarden gescheiden door `/`.

## Changelog Events

| Event Type | Beschrijving |
|---|---|
| `FEED_COLOR_ISSUES` | Producten met ontbrekende/ongeldige kleur (max 50 samples) |

## Configuratie

Tabel: `google_feed_config` (1 rij per tenant)

| Veld | Type | Beschrijving |
|---|---|---|
| `shop_url` | text | Basis-URL van de webshop |
| `feed_title` | text | Titel in RSS channel |
| `currency` | text | Standaard: EUR |
| `shipping_rules` | jsonb | Array van `{ country, price }` |
| `fallback_google_category` | text | GPC voor ongemapte producten |
| `fallback_gender` | text | Gender voor ongemapte producten |
| `fallback_age_group` | text | Leeftijdsgroep voor ongemapte producten |

Tabel: `google_category_mappings` (N rijen per tenant)

| Veld | Type | Beschrijving |
|---|---|---|
| `article_group_id` | text | Koppeling naar product.article_group.id |
| `google_category` | text | GPC categorie |
| `gender` | text | male/female/unisex |
| `age_group` | text | adult/kids |
| `material` | text | Materiaal override |
| `condition` | text | new/used/refurbished |
