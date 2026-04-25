# ISSPF Landing Pages

Static landing pages for ISSPF (International Soccer Science & Performance Federation) paid-traffic campaigns. Hosted on Cloudflare Pages, auto-deployed from this repo, with a Cloudflare Worker handling A/B test routing.

## Live domain

`go.isspf.com` (Cloudflare Pages, account: `neil@digitalsea.io`)

## Campaigns

| Slug | Live URL | Status | A/B test |
|---|---|---|---|
| `gk-report` | https://go.isspf.com/gk-report/ | LIVE | Active — A/B on H1 hammer |

## Repo structure

```
/
├── _worker.js               ← Cloudflare Worker (A/B routing)
├── wrangler.jsonc           ← Cloudflare config (build output, compat date)
├── .assetsignore            ← Files NOT served as public assets
├── .gitignore
├── README.md
└── gk-report/               ← Campaign folder, served at /gk-report/
    ├── index.html           ← Variant A (control)
    ├── variant-b.html       ← Variant B (challenger)
    ├── logo.jpg
    ├── partner-logos.png
    └── report-cover.png
```

## How A/B routing works

When a visitor hits `/gk-report/`:
1. Worker checks for cookie `ab_gk_report` (sticky variant assignment)
2. If no cookie, assigns A or B 50/50 and sets cookie for 90 days
3. Serves `index.html` (A) or `variant-b.html` (B) accordingly
4. Adds response headers `X-AB-Variant` and `X-AB-Test` for verification

The visitor sees the **same URL** in both cases — clean, no `?variant=B` in the address bar, no analytics fragmentation.

## Current A/B test (gk-report)

| Variant | H1 hammer | Descriptive headline |
|---|---|---|
| **A (control)** | The Goalkeeper Science Report | The science of goalkeeping that almost no coaching course teaches. |
| **B (challenger)** | 76% Of Goals Are Unsaveable. | So what are we actually training your goalkeepers to do? |

Test isolates a single variable: above-fold headline angle (product-name-led vs. stat-led).

### To verify which variant you got

Open DevTools → Network → click the page request → Response Headers. Look for:
- `X-AB-Variant: a` or `X-AB-Variant: b`

Or inspect the cookie `ab_gk_report` in Application → Cookies.

### To call a winner

1. Edit `_worker.js` and remove `'/gk-report'` from `AB_TESTS`
2. Optionally rename the winner: `mv gk-report/variant-b.html gk-report/index.html` (if B won)
3. Push

## Deployment

Pushing to `main` triggers a Cloudflare Pages deploy automatically. The Worker (`_worker.js`) is bundled into the deployment and runs at the edge before serving any asset.

`wrangler.jsonc` declares `pages_build_output_dir: "./"` — meaning the repo root IS the deployment root. Cloudflare Pages should not have any "Build output directory" set in the dashboard (or it should be empty).

## Forms

All three forms on `gk-report` post to arpReach at `https://email.isspf.com/a.php/sub/5f/71jczx`. The list captures email only (no first name yet).

Migration to **SignalFlux** is planned — when it happens, every `<form action>` URL needs updating across all variants.

## Sibling repo

[`urban-sketch-landing-pages`](https://github.com/V-Learn-Ltd/urban-sketch-landing-pages) — same architectural pattern, different brand, different Cloudflare account.
