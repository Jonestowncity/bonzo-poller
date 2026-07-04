import express from "express";
import { setInterval } from "timers";

// ─── Config ───────────────────────────────────────────────────────────────────
const BONZO_API_TOKEN = process.env.BONZO_API_TOKEN;
const POLLER_SHARED_SECRET = process.env.POLLER_SHARED_SECRET || "bm44-int-k3y-x9f2p7q1r8w5";
const INSTAFI_WEBHOOK_URL =
  process.env.INSTAFI_WEBHOOK_URL ||
  "https://instafi-mortgage.base44.app/functions/receivePollerLead";
const BONZO_API_BASE = "https://app.getbonzo.com/api/v3";
const POLL_INTERVAL_MS = 60 * 1000; // 1 minute
const LOOKBACK_MINUTES = 3; // fetch prospects updated in last 3 min (overlap for safety)
const INIT_LOOKBACK_DAYS = 10; // initial cache load window

// ─── State ────────────────────────────────────────────────────────────────────
const syncedIds = new Set();
let lastPollTime = null;
let lastPollStatus = "idle";
let totalSynced = 0;
let totalSkipped = 0;
let totalErrors = 0;
let lastError = null;
let pollCount = 0;
const startTime = Date.now();

// ─── Helpers ──────────────────────────────────────────────────────────────────
function s(obj, ...keys) {
  for (const k of keys) {
    const v = String(obj[k] || "").trim();
    if (v) return v;
  }
  return "";
}

function n(obj, ...keys) {
  for (const k of keys) {
    const raw = String(obj[k] || "").replace(/,/g, "").replace(/\$/g, "").trim();
    try {
      const v = parseFloat(raw);
      if (v !== 0 && !isNaN(v)) return v;
    } catch {}
  }
  return null;
}

function log(level, msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${level}] ${msg}`);
}

// ─── Bonzo API ────────────────────────────────────────────────────────────────
async function bonzoFetch(path, params = {}) {
  const qs = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  const url = `${BONZO_API_BASE}${path}?${qs}`;

  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${BONZO_API_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Bonzo API ${resp.status}: ${body.slice(0, 200)}`);
  }

  return resp.json();
}

async function fetchBonzoProspects(sinceISO, perPage = 50) {
  const all = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const data = await bonzoFetch("/prospects", {
      page,
      per_page: perPage,
      updated_after: sinceISO,
    });

    const prospects = Array.isArray(data) ? data : (data.data || data.prospects || []);
    if (!prospects.length) break;

    all.push(...prospects);

    // Check pagination
    if (Array.isArray(data)) {
      hasMore = false;
    } else {
      const meta = data.meta || data.pagination || {};
      const currentPage = meta.current_page || meta.page || page;
      const lastPage = meta.last_page || meta.total_pages || page;
      hasMore = currentPage < lastPage;
    }
    page++;
  }

  return all;
}

// ─── Lead Mapping ─────────────────────────────────────────────────────────────
function mapProspectToLeadPayload(p) {
  const bonzoId = String(p.id || "").trim();
  const co = p.coborrower || {};

  const notesParts = [];
  if (s(p, "bankruptcy")) notesParts.push(`Bankruptcy: ${s(p, "bankruptcy")} ${s(p, "bankruptcy_details")}`);
  if (s(p, "foreclosure")) notesParts.push(`Foreclosure: ${s(p, "foreclosure")}`);
  if (s(p, "occupation")) notesParts.push(`Occupation: ${s(p, "occupation")}`);
  if (s(p, "lender")) notesParts.push(`Current Lender: ${s(p, "lender")}`);
  if (co.first_name) {
    notesParts.push(`Co-Borrower: ${co.first_name || ""} ${co.last_name || ""} | ${co.email || ""} | ${co.phone || ""}`);
  }

  return {
    secret: POLLER_SHARED_SECRET,
    prospect: {
      id: bonzoId,
      leadmailbox_id: `bonzo_${bonzoId}`,
      first_name: s(p, "first_name"),
      last_name: s(p, "last_name"),
      email: s(p, "email"),
      home_phone: s(p, "phone"),
      address: s(p, "address"),
      city: s(p, "city"),
      state: s(p, "state"),
      zip: s(p, "zip"),
      loan_amount: n(p, "loan_amount"),
      loan_type: s(p, "loan_type"),
      loan_request: s(p, "loan_purpose"),
      down_payment: n(p, "down_payment"),
      purchase_price: n(p, "purchase_price"),
      property_value: n(p, "property_value"),
      cash_out_amount: n(p, "cash_out_amount"),
      credit_rating: s(p, "credit_score"),
      property_type: s(p, "property_type"),
      property_use: s(p, "property_use"),
      property_address: s(p, "property_address"),
      property_city: s(p, "property_city"),
      property_state: s(p, "property_state"),
      property_zip: s(p, "property_zip"),
      lead_source: s(p, "lead_source"),
      application_date: s(p, "application_date"),
      notes: notesParts.join(" | "),
      status: "New",
      raw_data: p,
    },
  };
}

// ─── InstaFi Webhook ──────────────────────────────────────────────────────────
async function pushLeadToInstaFi(payload) {
  const resp = await fetch(INSTAFI_WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-poller-key": POLLER_SHARED_SECRET,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`InstaFi webhook ${resp.status}: ${body.slice(0, 300)}`);
  }

  return resp.json().catch(() => ({}));
}

// ─── Poll Cycle ───────────────────────────────────────────────────────────────
async function pollCycle() {
  pollCount++;
  const since = new Date(Date.now() - LOOKBACK_MINUTES * 60 * 1000).toISOString();
  lastPollTime = new Date().toISOString();

  try {
    const prospects = await fetchBonzoProspects(since);
    let newCount = 0;
    let skipCount = 0;

    for (const p of prospects) {
      const bonzoId = String(p.id || "").trim();
      if (!bonzoId) continue;

      const first = s(p, "first_name");
      const last = s(p, "last_name");
      if (!first && !last) continue;

      if (syncedIds.has(bonzoId)) {
        skipCount++;
        continue;
      }

      try {
        const payload = mapProspectToLeadPayload(p);
        await pushLeadToInstaFi(payload);
        syncedIds.add(bonzoId);
        newCount++;
        totalSynced++;
        log("INFO", `Synced: ${first} ${last} (bonzo_${bonzoId})`);
      } catch (err) {
        totalErrors++;
        lastError = err["message"];
        log("ERROR", `Failed to sync bonzo_${bonzoId}: ${err["message"]}`);
      }
    }

    totalSkipped += skipCount;
    lastPollStatus = "ok";
    if (newCount > 0) {
      log("INFO", `Poll #${pollCount}: ${newCount} new, ${skipCount} skipped, ${prospects.length} total`);
    }
  } catch (err) {
    lastPollStatus = "error";
    lastError = err["message"];
    totalErrors++;
    log("ERROR", `Poll #${pollCount} failed: ${err["message"]}`);
  }
}

// ─── Initial Cache Load ───────────────────────────────────────────────────────
async function loadInitialCache() {
  log("INFO", `Loading initial cache: all Bonzo prospects from last ${INIT_LOOKBACK_DAYS} days...`);
  try {
    const since = new Date(Date.now() - INIT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const prospects = await fetchBonzoProspects(since, 100);

    for (const p of prospects) {
      const bonzoId = String(p.id || "").trim();
      if (bonzoId) syncedIds.add(bonzoId);
    }

    log("INFO", `Initial cache loaded: ${syncedIds.size} prospects cached. Will only sync NEW ones.`);
  } catch (err) {
    log("ERROR", `Initial cache load failed: ${err["message"]} — will start with empty cache`);
  }
}

// ─── Express Server ───────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({
    status: lastPollStatus === "error" ? "degraded" : "healthy",
    uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
    last_poll: lastPollTime,
    last_poll_status: lastPollStatus,
    last_error: lastError,
    poll_count: pollCount,
    cached_ids: syncedIds.size,
    total_synced: totalSynced,
    total_skipped: totalSkipped,
    total_errors: totalErrors,
  });
});

app.get("/status", (req, res) => {
  res.json({
    service: "bonzo-poller",
    poll_interval: "60s",
    lookback: `${LOOKBACK_MINUTES}min`,
    instafi_webhook: INSTAFI_WEBHOOK_URL,
    bonzo_api: BONZO_API_BASE,
    cached_ids: syncedIds.size,
    total_synced: totalSynced,
    total_skipped: totalSkipped,
    total_errors: totalErrors,
    last_poll: lastPollTime,
    last_poll_status: lastPollStatus,
    last_error: lastError,
    uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
  });
});

// Manual trigger endpoint
app.post("/trigger", async (req, res) => {
  log("INFO", "Manual poll trigger received");
  try {
    await pollCycle();
    res.json({ ok: true, status: lastPollStatus, synced: totalSynced });
  } catch (err) {
    res.status(500).json({ ok: false, error: err["message"] });
  }
});

// Reset cache endpoint (forces re-sync of everything in lookback window)
app.post("/reset-cache", async (req, res) => {
  const before = syncedIds.size;
  syncedIds.clear();
  log("INFO", `Cache cleared (${before} IDs removed). Reloading...`);
  await loadInitialCache();
  res.json({ ok: true, cleared: before, reloaded: syncedIds.size });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  log("INFO", `Bonzo Poller running on port ${PORT}`);
  log("INFO", `Polling every ${POLL_INTERVAL_MS / 1000}s | Lookback: ${LOOKBACK_MINUTES}min`);
  log("INFO", `InstaFi webhook: ${INSTAFI_WEBHOOK_URL}`);

  if (!BONZO_API_TOKEN) {
    log("ERROR", "BONZO_API_TOKEN not set — exiting");
    process.exit(1);
  }

  // Load initial cache so we don't re-sync existing prospects
  await loadInitialCache();

  // Start polling
  log("INFO", "Starting 1-minute poll cycle...");
  setInterval(pollCycle, POLL_INTERVAL_MS);

  // Run first cycle immediately
  pollCycle();
});
