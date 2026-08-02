# ISSPF Uptime Monitor

A standalone Cloudflare Worker that polls the ISSPF hosts every 5 minutes,
classifies **how** they fail, keeps 90 days of history, and emails you on
state changes.

## Why it's a separate Worker

Cloudflare **Pages Functions do not support Cron Triggers** — only a
standalone Worker can run a `scheduled()` handler. So this cannot live in the
root `_worker.js`, and it deploys separately from the Pages project.

It is in this repo for convenience only. It is excluded from the Pages
deployment via `.assetsignore`, so nothing here is served at `go.isspf.com`.

## What it actually tells you

A plain up/down light is not much help when a WordPress site flaps. The
useful information is *which layer* broke, and this records that on every
check:

| Classification | What it means | Where to look |
|---|---|---|
| `cloudflare-521` | Origin refused the connection | Web server down, or the host's firewall is blocking Cloudflare IPs |
| `cloudflare-522` | Origin never completed the handshake | **Most common on overloaded shared hosting** — CPU/RAM/process limits |
| `cloudflare-523` | Origin unreachable | Wrong origin IP in the Cloudflare DNS record, or host changed IPs |
| `cloudflare-524` | Origin took >100s to respond | Slow DB query, runaway `wp-cron`, a bad plugin |
| `cloudflare-525/526` | TLS failure to the origin | Expired or misconfigured origin certificate |
| `wp-database-down` | "Error establishing a database connection" | MySQL out of memory, or hit `max_connections` |
| `origin-5xx` | Origin returned its own 5xx | PHP-FPM crashed; check the PHP error log |
| `timeout` | No response within 30s | Origin hanging |
| `degraded` | Served, but slower than 5s | Early warning — this is what precedes a 522/524 |

Two details make the check trustworthy:

- **Cache is bypassed** (`cacheTtl: 0` plus a cache-busting query param).
  Without this, Cloudflare's edge can serve a cached copy and report "up"
  while the WordPress origin behind it is completely dead.
- **The body is inspected**, not just the status code. A WordPress database
  failure returns **HTTP 200** with an error message in the body — a HEAD
  request or status-code-only monitor scores that as a healthy site.

## Deploy

From the `monitor/` directory:

```bash
# 1. Create the KV namespace for history
npx wrangler kv namespace create MONITOR
#    → paste the returned id into wrangler.jsonc (replaces REPLACE_WITH_KV_NAMESPACE_ID)

# 2. Deploy (registers the cron trigger automatically)
npx wrangler deploy

# 3. Confirm it works right now, without waiting for the cron
curl https://isspf-uptime-monitor.<your-subdomain>.workers.dev/check
```

Then open the dashboard at the Worker's root URL. Put that URL into
`DASHBOARD_URL` in `wrangler.jsonc` and redeploy so alert emails link to it.

Use the Cloudflare account that already owns the Pages project
(`neil@digitalsea.io`).

### Alerts (optional but the whole point)

Without one of these configured, the Worker records everything but tells
nobody. Set at least one:

```bash
# Email via Resend (free tier is 3,000/month; MailChannels' free Workers
# API was terminated in 2024, so this is the current standard route)
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put ALERT_EMAIL_TO      # e.g. rebecca@v-learn.com,neil@digitalsea.io
npx wrangler secret put ALERT_EMAIL_FROM    # must be a domain verified in Resend

# ...and/or a Slack or Discord incoming webhook (works with either)
npx wrangler secret put ALERT_WEBHOOK_URL
```

Alerts fire **only on state transitions** (up→down, down→up), so a six-hour
outage sends two messages, not seventy-two.

### Locking the dashboard

The dashboard exposes no secrets, but if you'd rather it wasn't public:

```bash
npx wrangler secret put DASHBOARD_TOKEN
```

Every route then requires `?token=<value>`.

## Routes

| Route | Purpose |
|---|---|
| `/` | HTML dashboard — current state, 24h/7d/30d uptime, recent incidents |
| `/check` | Run all checks immediately and return the raw results |
| `/status.json` | Current state + uptime percentages as JSON |
| `/history` | Full stored incident log as JSON |

## Cost

Roughly 864 subrequests/day (3 hosts × 288 runs) and ~290 Worker
invocations/day. Comfortably inside the Workers free tier; KV writes are
~900/day against a 1,000/day free limit, so if you add a fourth target
either widen the cron to `*/10 * * * *` or move to the $5 paid plan.

## Local development

```bash
npx wrangler dev
# then trigger the scheduled handler manually:
curl "http://localhost:8787/cdn-cgi/handler/scheduled"
```

## Tests

No dependencies, no test runner — plain Node with a mocked `fetch` and KV:

```bash
cd monitor/test && node monitor.test.mjs
```

Covers the failure classification table, cache bypass, transition-only
alerting (including that a long outage doesn't re-alert every 5 minutes),
degraded-but-serving not paging, uptime maths, the dashboard token gate, and
that a failing email provider can't break the check loop.

## Tuning

All in `wrangler.jsonc` under `vars`:

- `TARGETS` — JSON array of `{name, url}` to poll
- `TIMEOUT_MS` — probe abort threshold (default 30000)
- `SLOW_MS` — the "degraded" threshold (default 5000)

Change the cadence via `triggers.crons`. Every 5 minutes means an outage is
caught within 5 minutes and costs you ~0.6% of the free KV write budget per
host per day.
