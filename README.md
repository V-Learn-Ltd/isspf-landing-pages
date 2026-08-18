# ISSPF Landing Pages

Static landing pages for ISSPF (International Soccer Science & Performance Federation) paid-traffic campaigns. Hosted on Cloudflare Pages, auto-deployed from this repo, with a Cloudflare Worker handling A/B test routing.

## Live domain

`go.isspf.com` (Cloudflare Pages, account: `neil@digitalsea.io`)

## Campaigns

| Slug | Live URL | Status | A/B test |
|---|---|---|---|
| `gk-report` | https://go.isspf.com/gk-report/ | LIVE | Active — A/B on H1 hammer |

The `/gk-report/thanks/` page delivers the report as a flipbook (see below), with
the PDF download kept as a secondary link.

## Flipbooks (`/book/<slug>/`)

Any ISSPF PDF or folder of page exports can be published as a page-curl flipbook,
so a report reads like a book in the browser instead of arriving as a 24MB
download. Built with [StPageFlip](https://github.com/Nodlik/StPageFlip) (MIT),
vendored locally — no CDN, no runtime dependency on anyone else's uptime.

| Slug | Live URL | Source | Pages |
|---|---|---|---|
| `gk-science-report` | https://go.isspf.com/book/gk-science-report/ | GK Science Campaign PDF | 23 |

### Add a book

```bash
# from a PDF
./tools/build-flipbook.sh \
  --pdf "/path/to/Report.pdf" \
  --slug my-report \
  --title "My Report" \
  --subtitle "ISSPF · 40 pages" \
  --pdf-url "https://www.isspf.com/wp-content/uploads/.../Report.pdf" \
  --cta-text "See The Courses" \
  --cta-url "https://go.isspf.com/smm/pro-youth-checkout/"

# or from a folder of page exports (most of the Dropbox PDF library is
# online-only, and some titles only exist as images)
./tools/build-flipbook.sh --images "/path/to/Page exports/" --slug my-report --title "My Report"
```

Then `git push`. Cloudflare Pages picks it up like any other page.

Requires `brew install poppler webp`.

### How it works

- Pages render to WebP at 1600px (desktop) and 900px (mobile), served via `srcset`.
  The 23-page report is about 8MB of images total, but only the first few load up
  front; the rest are lazy and warmed one spread ahead of the reader.
- The **aspect ratio is read from the source**, never hardcoded. A4 guidebooks
  (1:1.414) and US-Letter reports (1:1.294) both appear in this library, so a
  fixed ratio would letterbox or stretch half the catalogue.
- Cover and back cover are `data-density="hard"` so they behave as rigid boards.
- The book is sized to fit the viewport height, so the controls are never pushed
  below the fold.
- **If the library fails to load, the page falls back to a plain vertical scroll
  of the same images.** A reader who came for the report still gets it.

The PDF is deliberately *not* copied into this repo: git is a poor home for a
24MB binary and Cloudflare Pages caps one asset at 25MB. `--pdf-url` points the
download button at wherever the file already lives. `--host-pdf` overrides that
for small files.

### Shared runtime

`book/_lib/` holds `page-flip.browser.js` (vendored StPageFlip 2.0.7),
`stpageflip.css`, `flipbook.css` and `flipbook.js`. Every book loads the same
four files and differs only by the `window.BOOK_CONFIG` object the build script
writes into its `index.html`, so adding a title is a script run, not a code change.

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
