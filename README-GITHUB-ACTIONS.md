# SFTP Sync via GitHub Actions

Deze applicatie gebruikt **GitHub Actions** om XML bestanden van een SFTP server te synchroniseren naar Supabase.

## Waarom GitHub Actions?

Supabase Edge Functions draaien op Deno en kunnen geen:
- Native Node.js modules gebruiken (zoals ssh2 voor SFTP)
- Subprocesses aanroepen
- Temp files maken

Daarom gebruiken we GitHub Actions die:
- ✅ Elke 2 minuten automatisch draaien
- ✅ Node.js met native SFTP libraries kunnen gebruiken
- ✅ Gratis zijn (binnen GitHub Actions quota)
- ✅ Betrouwbaar en schaalbaar zijn

## Setup Instructies

### 1. Connect dit project met GitHub

1. Klik in Lovable op **GitHub → Connect to GitHub**
2. Autoriseer de Lovable GitHub App
3. Selecteer je GitHub account/organisatie
4. Klik op **Create Repository**

### 2. Voeg GitHub Secrets toe

Ga naar je GitHub repository → Settings → Secrets and variables → Actions

Voeg de volgende secrets toe:

| Secret Name | Value | Waar te vinden |
|-------------|-------|----------------|
| `SFTP_HOST` | `ssh.developmentplatform.nl` | Settings pagina in app |
| `SFTP_PORT` | `18765` | Settings pagina in app |
| `SFTP_USERNAME` | `u838-cexw8hzuw8l9` | Settings pagina in app |
| `SFTP_PRIVATE_KEY` | (SSH private key) | Je SSH private key content |
| `SFTP_INBOUND_PATH` | `/home/customer/www/developmentplatform.nl/public_html/kosterschoenmode/modis-to-wp` | Settings pagina |
| `SUPABASE_URL` | `https://dnllaaspkqqfuuxkvoma.supabase.co` | Van Lovable Cloud |
| `SUPABASE_ANON_KEY` | `eyJhbGci...` | Van Lovable Cloud |

**Let op:** Voor `SFTP_PRIVATE_KEY` gebruik je de **private key** (niet de public key). Deze begint met:
```
-----BEGIN OPENSSH PRIVATE KEY-----
...
-----END OPENSSH PRIVATE KEY-----
```

### 3. Test de workflow

De workflow draait automatisch elke 2 minuten, maar je kunt hem ook handmatig starten:

1. Ga naar je GitHub repo → Actions tab
2. Klik op "SFTP to Supabase Sync" workflow
3. Klik op "Run workflow"
4. Klik op "Run workflow" (groene knop)

### 4. Monitor de workflow

- **GitHub Actions**: Zie workflow runs in de Actions tab
- **Supabase Logs**: Check de edge function logs in Lovable
- **Jobs pagina**: Bekijk import jobs in de applicatie
- **Products pagina**: Controleer of producten zijn geïmporteerd

## Hoe het werkt

```mermaid
graph LR
    A[GitHub Actions<br/>Elke 2 min] --> B[Connect SFTP]
    B --> C[List XML files<br/>in /ready/]
    C --> D[Download XML]
    D --> E[Move to<br/>/processing/]
    E --> F[Call Supabase<br/>Edge Function]
    F --> G{Success?}
    G -->|Yes| H[Move to<br/>/archive/]
    G -->|No| I[Move to<br/>/error/]
```

## Directory Structuur op SFTP

```
/kosterschoenmode/modis-to-wp/
├── ready/          # Upload nieuwe XML files hier
├── processing/     # Bestanden die worden verwerkt
├── archive/        # Succesvol verwerkte bestanden
│   ├── 202501/     # Per maand gearchiveerd
│   └── 202502/
└── error/          # Mislukte bestanden
```

## Troubleshooting

### Workflow draait niet
- Check of de workflow is enabled in de Actions tab
- Controleer of alle secrets correct zijn ingevuld
- Kijk naar de laatste workflow run voor error messages

### SFTP connectie mislukt
- Verifieer `SFTP_PRIVATE_KEY` is correct gekopieerd (inclusief header/footer)
- Check of de SFTP server bereikbaar is vanaf GitHub Actions
- Test de credentials handmatig met een SFTP client

### Edge function errors
- Check de edge function logs in Lovable
- Verifieer dat `SUPABASE_URL` en `SUPABASE_ANON_KEY` correct zijn
- Controleer de XML structuur

### XML niet verwerkt
- Check of het bestand in de `/ready/` directory staat
- Wacht tot de volgende workflow run (max 2 minuten)
- Bekijk de workflow logs in GitHub Actions

## Workflow Schema

**Frequentie**: Elke 2 minuten (via cron: `*/2 * * * *`)

**Timing**: 
- 00:00, 00:02, 00:04, ... elke dag
- Kan ook handmatig getriggerd worden

**Kosten**: Gratis binnen GitHub Actions quota (2000 minuten/maand voor gratis accounts)
