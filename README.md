# Bonzo Poller

Polls the Bonzo API every 60 seconds and pushes new/updated prospects to InstaFi's `receivePollerLead` backend function.

## Architecture

```
Railway (this service)          InstaFi (Base44 app)
┌─────────────────────┐        ┌──────────────────────┐
│  Poll every 60s     │        │  receivePollerLead    │
│  Bonzo API v3       │──POST──│  (backend function)   │
│  /prospects         │        │  → Lead entity CRUD   │
│  In-memory dedup    │        │  → Dedup by bonzo_ID  │
└─────────────────────┘        └──────────────────────┘
```

- **Zero Base44 automation credits** — no agent triggered, just an HTTP call
- **60-second latency** instead of 60 minutes
- **In-memory dedup** — on startup, caches all Bonzo prospect IDs from the last 10 days, then only pushes truly new ones
- **3-minute lookback overlap** — prevents missing leads that were updated right at the poll boundary

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `BONZO_API_TOKEN` | ✅ | Bonzo API v3 bearer token |
| `POLLER_SHARED_SECRET` | ❌ | Shared secret for InstaFi webhook auth (default: `bm44-int-k3y-x9f2p7q1r8w5`) |
| `INSTAFI_WEBHOOK_URL` | ❌ | InstaFi backend function URL (default: `https://instafi-mortgage.base44.app/functions/receivePollerLead`) |
| `PORT` | ❌ | Express port (default: 3000, Railway sets this automatically) |

## Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Health check with stats |
| GET | `/status` | Detailed service status |
| POST | `/trigger` | Manually trigger a poll cycle |
| POST | `/reset-cache` | Clear dedup cache and reload from Bonzo |

## Deploy on Railway

1. Create a new Railway project from this GitHub repo
2. Set environment variables:
   - `BONZO_API_TOKEN` — the Bonzo API token
   - `POLLER_SHARED_SECRET` — must match the secret in InstaFi's `receivePollerLead` function
3. Railway will auto-detect Node.js and deploy
4. Check `/health` to verify it's running

## How It Works

1. **Startup**: Fetches all Bonzo prospects from the last 10 days and caches their IDs in memory
2. **Every 60 seconds**: Fetches prospects updated in the last 3 minutes from Bonzo API v3
3. **For each prospect**: If ID is NOT in cache → map to InstaFi Lead format → POST to `receivePollerLead`
4. **Dedup**: Cached IDs are skipped. If Railway restarts, it reloads the cache automatically.

## Cost

- Railway: Free tier or ~$5/mo for always-on
- Base44: **$0** — no automation credits, no agent triggers. Just HTTP calls to a backend function.
