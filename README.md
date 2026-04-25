# ISSPF Landing Pages

Static landing pages for ISSPF (International Soccer Science & Performance Federation) paid-traffic campaigns. Hosted on Cloudflare Pages, auto-deployed from this repo.

## Live domain

`go.isspf.com` (TBC at deploy time)

## Campaigns

| Path | Campaign | Status |
|---|---|---|
| `/goalkeeper-science-report/` | Goalkeeper Science Report — free PDF lead magnet (Meta paid traffic) | In development |

## Architecture

- **Static HTML** — single `index.html` per campaign, embedded CSS, no build step
- **Cloudflare Pages** — auto-deploys on push to `main`
- **Forms** — post directly to Sendy at `https://email.isspf.com/a.php/sub/...`
- **Tracking** — Microsoft Clarity (heatmaps + session recording) — to be added

## Deployment

Pushing to `main` triggers an automatic Cloudflare Pages deploy. The Cloudflare account on file is the ISSPF business account (`neil@digitalsea.io`), separate from other V-Learn brands.

## Sibling repos

- [`urban-sketch-landing-pages`](https://github.com/V-Learn25/urban-sketch-landing-pages) — same pattern for Urban Sketch (different Cloudflare account)
