# Modis Bridge

Een full-stack integratieplatform voor Modis ERP met WooCommerce synchronisatie en SFTP-gebaseerde data-uitwisseling.

## 🚀 Features

### Core Functionaliteit
- **SFTP Artikel Import**: Automatische import van Modis XML artikelbestanden
- **Order Export**: Export van WooCommerce orders naar Modis XML formaat
- **WooCommerce Sync**: Real-time synchronisatie van producten en voorraad
- **Job Queue**: Robuuste background processing met retry mechanisme
- **Health Monitoring**: Uitgebreide monitoring en diagnostics

### Technische Stack
- **Frontend**: React, TypeScript, Tailwind CSS, TanStack Query
- **Backend**: Supabase (PostgreSQL, Edge Functions, pg_cron)
- **Integraties**: SFTP, WooCommerce REST API
- **Scheduling**: Automated jobs via pg_cron (elke 2 minuten)

## 📁 SFTP Directory Structuur

```
/modis-to-wp/                    # Inbound: Modis → WooCommerce
├── ready/                       # Nieuwe XML bestanden voor import
├── processing/                  # Bestanden in verwerking
├── archive/YYYYMM/             # Succesvol verwerkte bestanden
└── error/                       # Mislukte imports met .err logs

/wp-to-modis/                    # Outbound: WooCommerce → Modis
├── ready/                       # Nieuwe order exports (.xml + .md5)
├── archive/YYYYMM/             # Afgehandelde exports (.ok/.err)
└── error/                       # Mislukte exports
```

## 🔄 Data Flow

### Artikel Import (Modis → WooCommerce)
1. **Upload**: XML bestand wordt geplaatst in `/modis-to-wp/ready/`
2. **Detection**: SFTP Watcher detecteert nieuw bestand (elke 2 min)
3. **Job Creation**: `IMPORT_ARTICLES_XML` job wordt aangemaakt
4. **Processing**: Job Scheduler pikt job op en roept `process-articles` aan
5. **Transform**: XML wordt geparsed en data wordt ge-upsert
6. **Archive**: Bij succes → `/archive/YYYYMM/`, bij error → `/error/`

### Order Export (WooCommerce → Modis)
1. **Trigger**: Order wordt aangemaakt via `/orders` API endpoint
2. **Job Creation**: `EXPORT_ORDER_XML` job wordt aangemaakt
3. **Processing**: Edge function genereert Modis XML
4. **Upload**: XML + MD5 hash naar `/wp-to-modis/ready/`
5. **Archive**: Verplaats naar `/archive/YYYYMM/`

## 🛠️ Setup

### SFTP Configuratie
Ga naar **Settings** → **SFTP** tab en configureer credentials.

### WooCommerce Configuratie
Ga naar **Settings** → **WooCommerce** tab en voer API credentials in.

## 🔌 API Endpoints

### Health Check
```bash
GET /functions/v1/health
```

### Process Article (Manual Trigger)
```bash
POST /functions/v1/process-articles
Content-Type: application/json

{
  "filename": "Modis-artikel-251023185526.XML",
  "sourcePath": "/modis-to-wp/ready"
}
```

### Export Order
```bash
POST /functions/v1/export-orders
Content-Type: application/json

{
  "orderNumber": "WC-12345"
}
```

## 🔍 Monitoring

Gebruik het Dashboard voor real-time monitoring van SFTP status, job queue en WooCommerce sync.

## 🚨 Troubleshooting

Check Edge Function logs in Lovable Cloud dashboard voor details.
