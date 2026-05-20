# ISSPF Checkout System — Setup Guide

> **Status:** Code complete (2026-05-20). Cloudflare-hosted checkout for `pro-youth-gk` and `senior-pro-masters-gk` courses. Stripe-powered, WishlistMember auto-enrolment, AffiliateWP sale tracking, Meta CAPI purchase events.
>
> **What this replaces:** The broken WordPress payment plugin on isspf.com. Cloudflare worker now handles payments → calls WishlistMember REST API to enrol buyer → WLM hands off to LearnDash as before.

---

## File map

```
/checkout/
  pro-youth-goalkeeper-coaching/index.html    # Pro-Youth checkout page
  pro-masters-goalkeeper-coaching/index.html  # Senior Pro Masters checkout
  thank-you/index.html                        # Stripe success destination

_worker.js  # Extended with:
  - /api/create-checkout-session
  - /api/stripe-webhook
  - /api/validate-coupon
  - /api/get-order-summary
  - /api/affwp-convert-sale
```

Pricing for both courses is defined in `_worker.js` → `COURSE_CONFIG`. Change numbers there if your team confirms different pricing.

---

## Live URLs (after deploy)

| Page | URL |
|---|---|
| Pro-Youth checkout | `https://go.isspf.com/checkout/pro-youth-goalkeeper-coaching/` |
| Senior Pro Masters checkout | `https://go.isspf.com/checkout/pro-masters-goalkeeper-coaching/` |
| Thank-you (Stripe success) | `https://go.isspf.com/checkout/thank-you/?session_id=...` |
| Stripe webhook endpoint | `https://go.isspf.com/api/stripe-webhook` |

The two sales-page ENROL CTAs have been updated to point to the new checkout URLs (previously they pointed to `https://learn.isspf.com/smm/buy-gk-*-smm/` — the broken WordPress payment).

---

## Setup steps — in order

### 1. Stripe Dashboard (15 minutes)

You don't need to create Products or Prices in Stripe. The worker creates checkout sessions inline with prices baked into each request (see `COURSE_CONFIG` in `_worker.js`).

You DO need:

1. **Get your API keys** — Stripe Dashboard → Developers → API keys
   - Copy the **Secret key** (starts `sk_live_...` for production, `sk_test_...` for testing)
   - Copy the **Publishable key** (starts `pk_live_...` or `pk_test_...`)
2. **Set up the webhook** — Stripe Dashboard → Developers → Webhooks → Add endpoint
   - **Endpoint URL:** `https://go.isspf.com/api/stripe-webhook`
   - **Events to send:** `checkout.session.completed` (only this one)
   - Save. Stripe shows the **Signing secret** (starts `whsec_...`). Copy it.
3. Recommended: Test in **Stripe test mode first** before flipping to live keys.

### 2. WishlistMember (10 minutes)

1. **Enable the WLM API**
   - WordPress admin → WishlistMember → Settings → Advanced → API
   - Toggle the API ON
   - Click **Generate API Key** if one doesn't exist
   - Copy the API key
2. **Find your Level IDs**
   - WordPress admin → WishlistMember → Levels
   - Each level shows an ID number. Note:
     - Pro-Youth Goalkeeper Coaching → Level ID = `?`
     - Senior Pro Masters Goalkeeper Coaching → Level ID = `?`
     - Goalkeeper Science Workbook (if bump is a level) → Level ID = `?`
3. **Note your WLM API base URL.** Standard format:
   - `https://www.isspf.com/wlmapi/v1.0` (most common)
   - OR `https://www.isspf.com/?wlmapi=/v1.0` (older WLM)
   - Test in browser: visiting `<base>/users?email=test@test.com` (with your API key as header `WLM3-API-KEY`) should return JSON

> **Quick verify the WLM API is responding:**
> ```bash
> curl -H "WLM3-API-KEY: YOUR_KEY" "https://www.isspf.com/wlmapi/v1.0/users?email=youremail@isspf.com"
> ```
> Should return JSON with a `users` array. If it 404s, try the `?wlmapi=` variant.

### 3. Configure Environment Variables — TWO PLACES (10 minutes)

**Important:** This project manages non-secret vars in `wrangler.jsonc` (not the Cloudflare dashboard). The dashboard will REJECT plain-text variable creation with the message "Environment variables for this project are being managed through wrangler.toml. Only Secrets (encrypted variables) can be managed via the Dashboard."

This is intentional and matches how AFFWP_PARENT_URL and META_PIXEL_ID are already configured.

#### A. Secrets — in Cloudflare Dashboard

Cloudflare Dashboard → Workers & Pages → `isspf-landing-pages` → Settings → Variables and Secrets → Add → mark as **Encrypt**

| Variable | Value |
|---|---|
| `STRIPE_SECRET_KEY` | `sk_live_...` (or `sk_test_...` while testing) |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` from Step 1.2 |
| `WLM_API_KEY` | Your WishlistMember API key from Step 2.1 |
| `AFFWP_PUBLIC_KEY` | (already configured — verify present) |
| `AFFWP_TOKEN` | (already configured — verify present) |
| `META_CAPI_ACCESS_TOKEN` | (already configured — verify present) |

#### B. Plain-text vars — edit `wrangler.jsonc` in the repo

Open `wrangler.jsonc`. Replace the `REPLACE_WITH_...` placeholders with real values:

```jsonc
"STRIPE_PUBLISHABLE_KEY": "pk_live_...",            // (or pk_test_... while testing)
"WLM_API_BASE_URL": "https://www.isspf.com/wlmapi/v1.0",   // confirm this works (see Step 2.3)
"WLM_LEVEL_PRO_YOUTH": "1",                          // numeric Level ID from WishlistMember
"WLM_LEVEL_SENIOR": "2",                             // numeric Level ID
"WLM_LEVEL_WORKBOOK_YOUTH": "3",                     // Youth workbook Level ID (or "" if not a WLM level)
"WLM_LEVEL_WORKBOOK_SENIOR": "4"                     // Senior workbook Level ID (or "" if not a WLM level)
```

Then `git commit -am "Configure checkout env vars"` and `git push`. Cloudflare auto-deploys, the new vars take effect immediately on the next request.

---

## Test plan

### Stripe test mode (do this first)

1. Use Stripe test keys in env vars (`sk_test_...` / `pk_test_...` / `whsec_...` from a TEST webhook endpoint)
2. Visit `https://go.isspf.com/checkout/pro-youth-goalkeeper-coaching/` in **incognito**
3. Click **Pay £49 — Enrol now**
4. On Stripe page: use card `4242 4242 4242 4242`, any future expiry, any CVC, any postal code
5. Should redirect to `/checkout/thank-you/` with a success state
6. Within 30 seconds, check WordPress admin → WishlistMember → Users → confirm the test email is enrolled at the right level
7. Check WordPress admin → LearnDash → Users → confirm course access granted

### Stripe live mode (after test passes)

1. Swap env vars to live Stripe keys
2. Recreate the webhook with **live** endpoint, save the new signing secret
3. Test with a real card (you can refund yourself afterwards in Stripe dashboard)
4. Same verification checklist

### Edge cases to test

- Buy with workbook bump enabled (checkbox ticked) — verify both course AND workbook are granted in WLM (if workbook = WLM level)
- Existing customer buys a second course — verify they get the new level added (not blocked by "user exists")
- AffiliateWP-tracked visitor buys — verify sale referral appears in `learn.isspf.com` AffiliateWP dashboard
- Meta Pixel — open Events Manager → Test Events → confirm `Purchase` event fires with correct value+currency

---

## What's NOT done yet (planned for tomorrow / Wednesday)

1. **PayPal Smart Button** — currently a placeholder button on the checkout page. The "/api/paypal-*" endpoints need to be built. ETA: 2-3 hours Wednesday morning.
2. **Cart abandonment sequence** — Meta CAPI fires `InitiateCheckout` and `AddToCart`, so retargeting audiences exist, but no email-based abandonment yet. Recommend Klaviyo-style 1h/24h/72h sequence triggered by `InitiateCheckout` event for cold visitors who didn't complete.
3. **GKSCIENCE25 (or replacement code)** — `COUPONS` block in `_worker.js` is empty. Decide whether you want a discount on top of the £49 tripwire (most likely answer: no, because the £49 IS the discount). If yes, add code to the `COUPONS` object and redeploy.

---

## Known issues / things to confirm

1. **Currency bugs in original geoip code** — the existing isspf.com geoip code had Malaysia, South Africa, Canada showing "€49" as discount price (wrong currency). I've fixed these in the new checkout pages with sensible defaults:
   - MY: RM249 / RM99 workbook
   - ZA: R899 / R349 workbook
   - CA: CA$79 / CA$32 workbook
   - **CONFIRM** these match the prices your team wants charged. Edit `PRICING` in each checkout HTML and `COURSE_CONFIG` in `_worker.js` if different.
2. **WLM API path** — the worker assumes `WLM_API_BASE_URL/users` for member creation. If WLM is on a different path (older WLM versions), update `enrollInWishlistMember()` in `_worker.js`.
3. **Workbook delivery** — there are TWO workbooks (Youth + Senior), each with its own WLM level. Pro-Youth course buyers who tick the bump get the Youth workbook; Senior Pro Masters buyers get the Senior workbook. If a workbook is a downloadable PDF rather than a WLM level, leave that workbook's env var (`WLM_LEVEL_WORKBOOK_YOUTH` or `WLM_LEVEL_WORKBOOK_SENIOR`) blank. The buyer is charged but the workbook isn't auto-delivered via WLM — you'd need a separate email or download link mechanism.
4. **Bundle** — not built. Bundle URL/price still pending per pre-existing notes.

---

## Architecture (for future-you)

```
Buyer on /pro-youth-goalkeeper-coaching/
   ↓ clicks ENROL NOW
   → /checkout/pro-youth-goalkeeper-coaching/
       ↓ geoip → picks currency → displays £49
       ↓ buyer ticks bump (workbook, +£19)
       ↓ buyer clicks Pay £68
       → POST /api/create-checkout-session
            → Cloudflare Worker builds Stripe Checkout session with price_data
            → Returns Stripe-hosted checkout URL
       → Browser redirects to checkout.stripe.com
   → Buyer enters card, completes
   → Stripe redirects to /checkout/thank-you/?session_id=...
   → In parallel: Stripe fires checkout.session.completed webhook
       → POST /api/stripe-webhook
            → Worker verifies signature (HMAC-SHA256)
            → Worker calls WLM POST /users with email + levels
            → WLM creates user + sends welcome email + adds to LearnDash
   → Thank-you page fires Meta Purchase event + AffWP sale referral
```

Everything is edge-deployed. No WordPress payment plugin in the critical path.

---

## Rollback plan

If something breaks in production:
1. Revert the sales-page CTA changes (point ENROL back to `https://learn.isspf.com/smm/buy-gk-*-smm/`)
2. Push to main — Cloudflare auto-deploys
3. Now you're back to the broken-but-known WP plugin state while you debug

In Stripe Dashboard, refund any failed-enrolment transactions and manually add the user in WLM admin to grant course access.

---

*Generated 2026-05-20 by the Claude session that diagnosed the conversion failure and built the replacement checkout system.*
