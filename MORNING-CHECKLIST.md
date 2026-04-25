# Morning Checklist — ISSPF Landing Page Launch

Three things to do in the morning. Once these are done, you can run paid traffic.

**⚠ Heads-up:** As of last night's push, the deploy verifies as **NOT yet live** at the new URL. Step 1 below is mandatory — it's a Cloudflare dashboard fix only you can do (requires the `neil@digitalsea.io` Cloudflare account). The OLD deployment (at `go.isspf.com/`) is still up — site is not down — but the new `/gk-report/` slug + A/B routing won't activate until you do step 1.

---

## 1. ⚠ MANDATORY — Fix Cloudflare Pages build output directory (60 seconds)

Last night the repo was restructured: `goalkeeper-science-report/` was renamed to `gk-report/`, the build output now declared via `wrangler.jsonc` to be the repo root. But the Cloudflare Pages dashboard still has "Build output directory" set to the old folder name, which is breaking the new deploy.

**Fix:**
1. Log into Cloudflare as `neil@digitalsea.io`
2. Workers & Pages → `isspf-landing-pages` project → **Settings** → **Builds & deployments**
3. Find **"Build output directory"**
4. **Clear the field completely** (leave empty) — `wrangler.jsonc` will take over
5. Click **Save**
6. Go to **Deployments** tab → click **"Retry deployment"** on the latest commit (or push any small change to trigger a rebuild)
7. Wait ~60 seconds for build to complete

**Verify it worked:**
- Open https://go.isspf.com/gk-report/ — should load the GK page
- `/` should now 404 (no root index.html exists in the new structure)

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
