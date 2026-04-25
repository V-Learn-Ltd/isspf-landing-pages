# Morning Checklist — ISSPF Landing Page Launch

Three things to verify in the morning. Each takes <2 minutes. Once these are done, you can run paid traffic.

---

## 1. Verify the new URL is live (10 seconds)

Visit **https://go.isspf.com/gk-report/** in a browser.

**Expected:** The Goalkeeper Science Report landing page loads. Could be either variant A (headline: "The Goalkeeper Science Report") or variant B (headline: "76% Of Goals Are Unsaveable.") — that's the A/B test working.

**If it 404s:** Cloudflare Pages may still have the old "Build output directory" set to `goalkeeper-science-report/` in the dashboard. Fix:
1. Cloudflare → `isspf-landing-pages` Pages project → **Settings** → **Builds & deployments**
2. Find **"Build output directory"**
3. Either **clear it** (leave empty) or set it to `/`
4. Click **Save**, then trigger a redeploy from the Deployments tab

The repo's `wrangler.jsonc` declares `pages_build_output_dir: "./"` so the dashboard setting may be ignored — but if there's a conflict, the dashboard wins. Clearing it is the safest move.

---

## 2. Test the A/B routing (60 seconds)

Open https://go.isspf.com/gk-report/ in a normal browser. Note which headline you see (A: "The Goalkeeper Science Report" / B: "76% Of Goals Are Unsaveable.").

Then open https://go.isspf.com/gk-report/ in a **private / incognito window**. You should *sometimes* see the other variant (50/50 chance per fresh session). Refresh a few times in the same private window — should stay on the same variant (sticky cookie).

**Verify the response header:**
- DevTools → Network → click the page request → Response Headers
- Should see `X-AB-Variant: a` or `X-AB-Variant: b`

If the header is missing, the Worker isn't running. Possible causes:
- Pages didn't pick up `_worker.js` — check the latest deploy log for any Worker errors
- Build output directory misconfigured (see step 1)

---

## 3. Set the arpReach thank-you redirect (60 seconds)

When someone submits the form, they currently get redirected to arpReach's default thank-you page. Looks generic. Fix it:

1. Log into arpReach at https://email.isspf.com/
2. Go to the **GK Report list** (the one with form ID `71jczx`)
3. Find **Confirmation Page** or **Thank You URL** setting (location varies by arpReach version — usually under list settings or autoresponder settings)
4. Set it to: `https://go.isspf.com/gk-report/thanks/` (we'll build this page later — for now just point at the GK report URL)

Or for simplest version this morning, point at **https://go.isspf.com/gk-report/?subscribed=1** so visitors don't bounce to arpReach's branded page.

---

## What's already done (overnight)

- ✅ Repo restructured: `goalkeeper-science-report/` → `gk-report/`
- ✅ Variant B created (`gk-report/variant-b.html`) with stat-led headline
- ✅ Cloudflare Worker (`_worker.js`) for A/B routing — sticky cookie, 50/50 split
- ✅ `wrangler.jsonc` declaring repo root as build output
- ✅ `.assetsignore` so worker files don't leak to public
- ✅ README updated to document the multi-campaign structure
- ✅ Pushed to GitHub → Cloudflare Pages auto-deploys

## What's NOT done (tomorrow's work, not blocking launch)

- ❌ Microsoft Clarity heatmap tracking (need your Clarity project ID)
- ❌ A proper thank-you page at `/gk-report/thanks/` (placeholder for arpReach redirect)
- ❌ A/B test outcome tracking dashboard (we need ~200 clicks before this matters)

---

## To call the A/B test winner later

Once you have data (recommend minimum 7 days + 100 visitors per variant + p < 0.05):

1. Edit `_worker.js`, remove `'/gk-report': 'ab_gk_report',` from `AB_TESTS`
2. If B won: rename `gk-report/variant-b.html` → `gk-report/index.html` (replacing the old A)
3. Commit + push
4. Cloudflare auto-deploys — all traffic now sees the winner
