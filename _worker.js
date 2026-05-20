/**
 * Cloudflare Pages Worker — A/B routing + AffiliateWP tracking + Meta CAPI
 *
 * Three responsibilities:
 *
 * 1. A/B test routing for selected paths (currently /gk-report)
 *    - Sticky 50/50 random assignment via cookie
 *    - Rewrites to variant-b extensionless path for the challenger
 *
 * 2. AffiliateWP cross-domain tracking on ALL pages
 *    - When ?a=<id> is present, calls AffiliateWP REST API server-to-server
 *      to create a visit (so it appears in the affiliate's dashboard)
 *    - Drops affwp_affiliate_id and affwp_visit_id cookies for 365 days
 *    - First-touch wins: existing affiliate cookies are NOT overwritten
 *
 * 3. Meta Conversions API forwarding via /api/meta-capi
 *    - Receives event_name + event_id + custom_data from the browser pixel
 *    - Reads _fbp / _fbc cookies (Meta first-party identifiers) + IP + UA
 *    - Hashes any PII (email, phone) before forwarding
 *    - POSTs to graph.facebook.com so events arrive even when the browser
 *      pixel is blocked (iOS, ad-blockers, cookie-consent rejection)
 *    - event_id is shared with the browser pixel call so Meta dedupes
 *
 * Configuration (wrangler.jsonc vars + Cloudflare dashboard secrets):
 *   AFFWP_PARENT_URL         - https://learn.isspf.com (vars)
 *   AFFWP_REF_VAR            - "a" (vars)
 *   AFFWP_COOKIE_DAYS        - "365" (vars)
 *   AFFWP_CREDIT_LAST        - "false" (vars) — first-touch wins
 *   AFFWP_PUBLIC_KEY         - AffiliateWP REST API public key (secret)
 *   AFFWP_TOKEN              - AffiliateWP REST API token (secret)
 *   META_PIXEL_ID            - 856256648998431 (vars)
 *   META_CAPI_ACCESS_TOKEN   - Meta CAPI access token (secret)
 *   META_TEST_EVENT_CODE     - Optional, only set during Events Manager testing (secret)
 */

// ─────────────────────────────────────────────────────────────
// A/B TEST CONFIGURATION
// ─────────────────────────────────────────────────────────────

const AB_TESTS = {
  // path (without trailing slash) → cookie name
  '/gk-report': 'ab_gk_report',
};

const VARIANT_COOKIE_MAX_AGE = 60 * 60 * 24 * 90; // 90 days


export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '');
    const cookies = parseCookies(request.headers.get('cookie') || '');

    // ── /api/affwp-convert — fire a lead-conversion referral ──
    // Called from /gk-report/check-inbox/ once the visitor has submitted the form.
    // Reads the affwp_affiliate_id + affwp_visit_id cookies (set by Step 1 below
    // when the affiliate-tagged URL was first hit), and POSTs a zero-amount
    // referral to AffiliateWP so the lead shows up against the affiliate.
    if (url.pathname === '/api/affwp-convert' && request.method === 'POST') {
      return await handleAffiliateConvert(request, env, cookies);
    }
    if (url.pathname === '/api/affwp-convert' && request.method === 'OPTIONS') {
      return new Response(null, { status: 204 });
    }

    // ── /api/meta-capi — server-side mirror of a browser pixel event ──
    // Called from every landing page in parallel with the browser fbq() call.
    // Browser sends { event_name, event_id, event_source_url, custom_data,
    // user_data? }; the worker enriches with IP, UA, _fbp/_fbc cookies and
    // POSTs to graph.facebook.com. Meta dedupes browser+server by event_id.
    if (url.pathname === '/api/meta-capi' && request.method === 'POST') {
      return await handleMetaCAPIEvent(request, env, cookies);
    }
    if (url.pathname === '/api/meta-capi' && request.method === 'OPTIONS') {
      return new Response(null, { status: 204 });
    }

    // ── /api/create-checkout-session — Stripe Checkout session creator (legacy redirect flow) ──
    if (url.pathname === '/api/create-checkout-session' && request.method === 'POST') {
      return await handleCreateCheckoutSession(request, env);
    }
    if (url.pathname === '/api/create-checkout-session' && request.method === 'OPTIONS') {
      return new Response(null, { status: 204 });
    }

    // ── /api/stripe-config — returns publishable key for embedded Stripe Elements ──
    if (url.pathname === '/api/stripe-config' && request.method === 'GET') {
      return jsonResponse({ ok: true, publishable_key: env.STRIPE_PUBLISHABLE_KEY || null });
    }

    // ── /api/paypal-config — returns PayPal client ID + mode for SDK loader ──
    if (url.pathname === '/api/paypal-config' && request.method === 'GET') {
      return jsonResponse({ ok: true, client_id: env.PAYPAL_CLIENT_ID || null, mode: env.PAYPAL_MODE || 'live' });
    }

    // ── /api/paypal-create-order — creates a PayPal order, returns order ID ──
    if (url.pathname === '/api/paypal-create-order' && request.method === 'POST') {
      return await handlePaypalCreateOrder(request, env);
    }
    if (url.pathname === '/api/paypal-create-order' && request.method === 'OPTIONS') {
      return new Response(null, { status: 204 });
    }

    // ── /api/paypal-capture-order — captures an approved PayPal order + enrols in WLM ──
    if (url.pathname === '/api/paypal-capture-order' && request.method === 'POST') {
      return await handlePaypalCaptureOrder(request, env);
    }
    if (url.pathname === '/api/paypal-capture-order' && request.method === 'OPTIONS') {
      return new Response(null, { status: 204 });
    }

    // ── /api/create-payment-intent — embedded Stripe Elements flow ──
    if (url.pathname === '/api/create-payment-intent' && request.method === 'POST') {
      return await handleCreatePaymentIntent(request, env);
    }
    if (url.pathname === '/api/create-payment-intent' && request.method === 'OPTIONS') {
      return new Response(null, { status: 204 });
    }

    // ── /api/stripe-webhook — Stripe webhook receiver + WLM enrolment ──
    if (url.pathname === '/api/stripe-webhook' && request.method === 'POST') {
      return await handleStripeWebhook(request, env);
    }

    // ── /api/validate-coupon — Coupon code validator ──
    if (url.pathname === '/api/validate-coupon' && request.method === 'POST') {
      return await handleValidateCoupon(request, env);
    }
    if (url.pathname === '/api/validate-coupon' && request.method === 'OPTIONS') {
      return new Response(null, { status: 204 });
    }

    // ── /api/get-order-summary — Order details for thank-you page ──
    if (url.pathname === '/api/get-order-summary' && request.method === 'GET') {
      return await handleGetOrderSummary(url, env);
    }

    // ── /api/affwp-convert-sale — Affiliate sale conversion (post-purchase) ──
    if (url.pathname === '/api/affwp-convert-sale' && request.method === 'POST') {
      return await handleAffwpConvertSale(request, env, cookies);
    }

    // ── /smm/ CHECKOUT → REDIRECT TO WORDPRESS PAYMENT PAGES ──
    // Per user directive 2026-05-20: while the embedded Stripe/PayPal flow is
    // not yet tested end-to-end, send all /smm/ checkout traffic to the
    // existing WordPress payment pages which are known working. The new
    // /smm/ checkout pages remain in the repo (kept as Plan B) but the
    // redirect short-circuits before they render.
    // To re-enable the embedded checkout, remove this block.
    const SMM_CHECKOUT_REDIRECTS = {
      '/smm/pro-youth-goalkeeper-coaching':   'https://learn.isspf.com/smm/buy-gk-youth-smm/84qhnqg19r8pps3/',
      '/smm/pro-masters-goalkeeper-coaching': 'https://learn.isspf.com/smm/buy-gk-senior-smm/83wjg2gjsxd8e/'
    };
    const redirectTarget = SMM_CHECKOUT_REDIRECTS[path];
    if (redirectTarget) {
      // Preserve any query params (utm, affiliate ref, etc.) onto the WP URL
      const target = new URL(redirectTarget);
      url.searchParams.forEach((v, k) => { if (!target.searchParams.has(k)) target.searchParams.set(k, v); });
      return Response.redirect(target.toString(), 302);
    }

    // ── Step 1: Resolve the response (A/B routing or pass-through) ──
    let response;
    let isNewABAssignment = false;
    let abVariant = null;
    let abCookieName = null;

    abCookieName = AB_TESTS[path];
    if (abCookieName) {
      // Read existing variant from cookie if present
      const cookieMatch = (request.headers.get('cookie') || '')
        .match(new RegExp(`${abCookieName}=([ab])`));
      abVariant = cookieMatch ? cookieMatch[1] : null;

      // Assign new variant 50/50 if no cookie
      if (!abVariant) {
        isNewABAssignment = true;
        abVariant = Math.random() < 0.5 ? 'a' : 'b';
      }

      // Rewrite to variant path. Use canonical extensionless form to avoid
      // Cloudflare Pages 308-redirect loops.
      const targetPath = abVariant === 'b' ? `${path}/variant-b` : `${path}/`;
      const rewriteUrl = new URL(targetPath, url.origin);
      rewriteUrl.search = url.search; // preserve ?a= and other query params
      const rewriteRequest = new Request(rewriteUrl.toString(), request);
      response = await env.ASSETS.fetch(rewriteRequest);
    } else {
      response = await env.ASSETS.fetch(request);
    }

    // ── Step 2: Decide if any post-processing is needed ──
    const refVar = env.AFFWP_REF_VAR || 'a';
    const affiliateId = url.searchParams.get(refVar);
    const campaign = url.searchParams.get('campaign') || '';

    const contentType = response.headers.get('content-type') || '';
    const pathname = url.pathname;
    const isHtmlContent = contentType.includes('text/html');
    const isHtmlPath = pathname.endsWith('/') || pathname.endsWith('.html') || pathname === '';
    const isHtml = isHtmlContent || isHtmlPath;

    const needsAffiliate = affiliateId && isHtml;
    const needsABCookie = isNewABAssignment;

    if (!needsAffiliate && !needsABCookie) {
      return response;
    }

    // ── Step 3: Build a mutable response so we can attach cookies ──
    const newResponse = new Response(response.body, response);

    // Attach A/B cookie + diagnostic headers
    if (abCookieName) {
      if (needsABCookie) {
        newResponse.headers.append(
          'set-cookie',
          `${abCookieName}=${abVariant}; Path=/; Max-Age=${VARIANT_COOKIE_MAX_AGE}; SameSite=Lax; Secure`
        );
      }
      newResponse.headers.set('x-ab-variant', abVariant);
      newResponse.headers.set('x-ab-test', abCookieName);
    }

    // Attach affiliate cookies + create visit
    if (needsAffiliate) {
      const cookieDays = parseInt(env.AFFWP_COOKIE_DAYS || '365', 10);
      const creditLast = (env.AFFWP_CREDIT_LAST || 'false') === 'true';

      const existingAffiliate = cookies['affwp_affiliate_id'];
      const existingVisit = cookies['affwp_visit_id'];

      // First-touch wins: only track if we have no existing affiliate cookie,
      // or if creditLast is explicitly enabled.
      const shouldTrack = creditLast || !existingAffiliate || !existingVisit;

      if (shouldTrack) {
        const visitId = await createAffiliateVisit(request, url, env, affiliateId, campaign);

        const maxAge = cookieDays * 86400;
        const cookieOpts = `Path=/; Max-Age=${maxAge}; SameSite=Lax`;

        newResponse.headers.append(
          'set-cookie',
          `affwp_affiliate_id=${affiliateId}; ${cookieOpts}`
        );

        if (campaign) {
          newResponse.headers.append(
            'set-cookie',
            `affwp_campaign=${encodeURIComponent(campaign)}; ${cookieOpts}`
          );
        }

        if (visitId) {
          newResponse.headers.append(
            'set-cookie',
            `affwp_visit_id=${visitId}; ${cookieOpts}`
          );
        }

        // Diagnostic header so we can verify in DevTools
        newResponse.headers.set('x-affwp-tracked', `${affiliateId}${visitId ? '/v' + visitId : '/no-visit'}`);
      } else {
        newResponse.headers.set('x-affwp-tracked', `skip-existing-${existingAffiliate}`);
      }
    }

    return newResponse;
  },
};


// ─────────────────────────────────────────────────────────────
// AFFILIATE CONVERSION HANDLER
// ─────────────────────────────────────────────────────────────

/**
 * Convert the current visitor's tracked visit into a referral.
 * Called from /gk-report/check-inbox/ after a successful opt-in.
 *
 * Returns JSON describing the outcome:
 *   { ok: true, referral_id, affiliate_id, visit_id }      — success
 *   { ok: true, skipped: 'no-affiliate' }                  — visitor isn't affiliate-attributed
 *   { ok: false, error: '...' }                            — API call failed
 */
async function handleAffiliateConvert(request, env, cookies) {
  const affiliateId = cookies['affwp_affiliate_id'];
  const visitId = cookies['affwp_visit_id'];

  // No affiliate cookie = visitor wasn't referred. Return ok with skipped reason.
  if (!affiliateId) {
    return jsonResponse({ ok: true, skipped: 'no-affiliate' });
  }

  const parentUrl = (env.AFFWP_PARENT_URL || '').replace(/\/$/, '');
  const publicKey = env.AFFWP_PUBLIC_KEY || '';
  const token = env.AFFWP_TOKEN || '';
  const referralType = env.AFFWP_LEAD_TYPE || 'opt-in';
  const referralContext = env.AFFWP_LEAD_CONTEXT || 'gk-report-lead';
  const referralDescription = env.AFFWP_LEAD_DESCRIPTION || 'Goalkeeper Science Report opt-in';

  if (!parentUrl || !publicKey || !token) {
    return jsonResponse({ ok: false, error: 'missing-config' }, 500);
  }

  try {
    const apiParams = new URLSearchParams({
      affiliate_id: affiliateId,
      amount: '0',
      type: referralType,
      context: referralContext,
      description: referralDescription,
      status: 'unpaid',
    });
    if (visitId) {
      apiParams.set('visit_id', visitId);
    }

    const apiUrl = `${parentUrl}/wp-json/affwp/v1/referrals?${apiParams.toString()}`;
    const authHeader = 'Basic ' + btoa(`${publicKey}:${token}`);

    const apiResponse = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: '',
    });

    const responseText = await apiResponse.text();

    if (!apiResponse.ok) {
      console.error('[AffWP convert] API error:', apiResponse.status, responseText.substring(0, 300));
      return jsonResponse({
        ok: false,
        error: 'api-error',
        status: apiResponse.status,
        body: responseText.substring(0, 300),
      }, 502);
    }

    let referralId = null;
    try {
      const data = JSON.parse(responseText);
      referralId = data.referral_id || data.id || null;
    } catch (parseErr) {
      console.error('[AffWP convert] Failed to parse API response:', parseErr.message);
    }

    return jsonResponse({
      ok: true,
      referral_id: referralId,
      affiliate_id: affiliateId,
      visit_id: visitId || null,
    });
  } catch (err) {
    console.error('[AffWP convert] Request failed:', err.message);
    return jsonResponse({ ok: false, error: 'request-failed', message: err.message }, 502);
  }
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'Cache-Control': 'no-store',
    },
  });
}


// ─────────────────────────────────────────────────────────────
// AFFILIATE TRACKING HELPER
// ─────────────────────────────────────────────────────────────

/**
 * Create a visit via AffiliateWP REST API. Returns visit_id or null.
 */
async function createAffiliateVisit(request, url, env, affiliateId, campaign) {
  const parentUrl = (env.AFFWP_PARENT_URL || '').replace(/\/$/, '');
  const publicKey = env.AFFWP_PUBLIC_KEY || '';
  const token = env.AFFWP_TOKEN || '';

  if (!parentUrl || !publicKey || !token) {
    console.error('[AffWP] Missing environment variables - cannot track visit');
    return null;
  }

  const visitorIp = request.headers.get('cf-connecting-ip')
    || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || '0.0.0.0';

  const landingUrl = url.origin + url.pathname;
  const referrer = request.headers.get('referer') || '';

  try {
    const apiParams = new URLSearchParams({
      affiliate_id: affiliateId,
      ip: visitorIp,
      url: landingUrl,
      campaign: campaign,
      referrer: referrer,
    });

    const apiUrl = `${parentUrl}/wp-json/affwp/v1/visits?${apiParams.toString()}`;
    const authHeader = 'Basic ' + btoa(`${publicKey}:${token}`);

    const apiResponse = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: '',
    });

    const responseText = await apiResponse.text();

    if (apiResponse.ok) {
      try {
        const data = JSON.parse(responseText);
        return data.visit_id || data.id || null;
      } catch (parseErr) {
        console.error('[AffWP] Failed to parse API response:', parseErr.message);
      }
    } else {
      console.error('[AffWP] API error:', apiResponse.status, responseText.substring(0, 300));
    }
  } catch (err) {
    console.error('[AffWP] API request failed:', err.message);
  }

  return null;
}


// ─────────────────────────────────────────────────────────────
// META CONVERSIONS API HANDLER
// ─────────────────────────────────────────────────────────────

/**
 * Forward a single browser-fired pixel event to Meta CAPI server-side.
 * Browser sends a JSON body shaped:
 *   {
 *     event_name:        'PageView' | 'Lead' | 'ViewContent' | 'InitiateCheckout' | ...
 *     event_id:          UUID (must match the eventID passed to fbq for dedupe)
 *     event_source_url:  full URL of the page that fired the event
 *     custom_data:       object — content_name, content_category, content_ids, value, currency, etc.
 *     user_data:         optional — { email, phone, first_name, last_name } in plaintext;
 *                        worker hashes before forwarding
 *   }
 *
 * Returns:
 *   { ok: true, event_name, event_id, fbtrace_id }   — forwarded successfully
 *   { ok: false, error: '...' }                      — config or upstream error
 */
async function handleMetaCAPIEvent(request, env, cookies) {
  const pixelId = env.META_PIXEL_ID || '';
  const accessToken = env.META_CAPI_ACCESS_TOKEN || '';

  if (!pixelId || !accessToken) {
    console.error('[Meta CAPI] Missing META_PIXEL_ID or META_CAPI_ACCESS_TOKEN');
    return jsonResponse({ ok: false, error: 'missing-config' }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonResponse({ ok: false, error: 'invalid-json' }, 400);
  }

  const eventName = body.event_name;
  if (!eventName || typeof eventName !== 'string') {
    return jsonResponse({ ok: false, error: 'missing-event-name' }, 400);
  }

  const ip = request.headers.get('cf-connecting-ip')
    || (request.headers.get('x-forwarded-for') || '').split(',')[0].trim()
    || '';
  const userAgent = request.headers.get('user-agent') || '';
  const fbp = cookies['_fbp'] || '';
  const fbc = cookies['_fbc'] || '';

  // user_data: required by Meta for matching. fbp/fbc when present give the
  // best match quality; IP+UA is the fallback.
  const ud = {
    client_ip_address: ip,
    client_user_agent: userAgent,
  };
  if (fbp) ud.fbp = fbp;
  if (fbc) ud.fbc = fbc;

  // Hash any PII the browser passed (lowercase + trim before SHA-256).
  if (body.user_data && typeof body.user_data === 'object') {
    const u = body.user_data;
    if (u.email && typeof u.email === 'string') {
      ud.em = [await sha256(u.email.trim().toLowerCase())];
    }
    if (u.phone && typeof u.phone === 'string') {
      ud.ph = [await sha256(u.phone.replace(/[^0-9]/g, ''))];
    }
    if (u.first_name && typeof u.first_name === 'string') {
      ud.fn = [await sha256(u.first_name.trim().toLowerCase())];
    }
    if (u.last_name && typeof u.last_name === 'string') {
      ud.ln = [await sha256(u.last_name.trim().toLowerCase())];
    }
  }

  const eventPayload = {
    data: [{
      event_name: eventName,
      event_time: Math.floor(Date.now() / 1000),
      event_id: body.event_id || undefined,
      event_source_url: body.event_source_url || request.headers.get('referer') || '',
      action_source: 'website',
      user_data: ud,
      custom_data: (body.custom_data && typeof body.custom_data === 'object') ? body.custom_data : {},
    }],
  };

  if (env.META_TEST_EVENT_CODE) {
    eventPayload.test_event_code = env.META_TEST_EVENT_CODE;
  }

  try {
    const apiUrl = `https://graph.facebook.com/v21.0/${pixelId}/events?access_token=${encodeURIComponent(accessToken)}`;
    const apiResponse = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(eventPayload),
    });
    const responseText = await apiResponse.text();

    if (!apiResponse.ok) {
      console.error('[Meta CAPI] API error:', apiResponse.status, responseText.substring(0, 300));
      return jsonResponse({
        ok: false,
        error: 'api-error',
        status: apiResponse.status,
        body: responseText.substring(0, 300),
      }, 502);
    }

    let fbtraceId = null;
    try {
      const data = JSON.parse(responseText);
      fbtraceId = data.fbtrace_id || null;
    } catch (parseErr) {
      // Ignore — graph API normally returns valid JSON, but missing one is non-fatal
    }

    return jsonResponse({
      ok: true,
      event_name: eventName,
      event_id: body.event_id || null,
      fbtrace_id: fbtraceId,
    });
  } catch (err) {
    console.error('[Meta CAPI] Request failed:', err.message);
    return jsonResponse({ ok: false, error: 'request-failed', message: err.message }, 502);
  }
}

async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}


// ─────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────

function parseCookies(cookieStr) {
  const cookies = {};
  if (!cookieStr) return cookies;
  cookieStr.split(';').forEach(pair => {
    const [name, ...rest] = pair.trim().split('=');
    if (name) {
      cookies[name.trim()] = decodeURIComponent(rest.join('=').trim());
    }
  });
  return cookies;
}


// ─────────────────────────────────────────────────────────────
// CHECKOUT + WISHLIST MEMBER CONFIG
// ─────────────────────────────────────────────────────────────

/**
 * Course → WishlistMember level mapping + Stripe metadata.
 * Neil edits this directly when level IDs are confirmed in WP admin.
 * Stripe doesn't need price IDs because we send the amount inline per-currency
 * (Stripe accepts ad-hoc prices via price_data on Checkout Session creation).
 */
const COURSE_CONFIG = {
  'pro-youth-gk': {
    name: 'Pro-Youth Goalkeeper Coaching Science',
    description: 'Professional Certificate in Goalkeeper Coaching Science (Pro-Youth Level) — 10 modules, 9 faculty. Lifetime access.',
    wlm_level_env: 'WLM_LEVEL_PRO_YOUTH',
    prices: {
      // currency: amount in smallest unit (pence/cents). Coupon (e.g. GKSCIENCE25)
      // discounts this server-side before sending to Stripe.
      gbp: 24900,
      usd: 32900,
      eur: 29900,
      aud: 47900,
      cad: 47900,
      myr: 129900,
      zar: 459900
    },
    workbook: {
      name: 'Pro-Youth Goalkeeper Science Workbook',
      description: 'Printed companion to the Pro-Youth course — shipped to your door. Chapter summaries, training prompts, weekly planning, reflection questions.',
      wlm_level_env: 'WLM_LEVEL_WORKBOOK_YOUTH',
      // Prices in smallest currency unit. Confirmed against WLM Edit Forms 2026-05-20.
      // UK £39.99 / US $49.99 / EUR €44.99 / AU $74.99 / CA $74.99 / MY RM199 / ZA R799
      prices: { gbp: 3999, usd: 4999, eur: 4499, aud: 7499, cad: 7499, myr: 19900, zar: 79900 }
    }
  },
  'senior-pro-masters-gk': {
    name: 'Senior Pro Masters Goalkeeper Coaching Science',
    description: 'Professional Certificate in Goalkeeper Coaching Science (Senior Pro Masters Level) — 19 modules, 14 faculty. Lifetime access.',
    wlm_level_env: 'WLM_LEVEL_SENIOR',
    prices: {
      gbp: 32900,
      usd: 44900,
      eur: 35900,
      aud: 65900,
      cad: 65900,
      myr: 169900,
      zar: 699900
    },
    workbook: {
      name: 'Senior Pro Masters Goalkeeper Science Workbook',
      description: 'Printed companion to the Senior Pro Masters course — shipped to your door. Chapter summaries, match-day prompts, weekly planning, reflection questions.',
      wlm_level_env: 'WLM_LEVEL_WORKBOOK_SENIOR',
      // Confirmed against WLM Edit Forms 2026-05-20.
      // UK £49.99 / US $69.99 / EUR €59.99 / AU $94.99 / CA $94.99 / MY RM259 / ZA R999
      prices: { gbp: 4999, usd: 6999, eur: 5999, aud: 9499, cad: 9499, myr: 25900, zar: 99900 }
    }
  }
};

/**
 * Coupon codes — keyed UPPERCASE.
 * Add/remove codes here. Redeploy worker for changes to take effect.
 * `applies_to`: 'all' or array of course_ids.
 */
const COUPONS = {
  // GKSCIENCE25 — 25% off both courses. Used in the email sequence.
  // Add an 'expires' ISO date if you want it to auto-disable.
  'GKSCIENCE25': { percent: 25, applies_to: 'all' }
};


// ─────────────────────────────────────────────────────────────
// STRIPE CHECKOUT SESSION CREATION
// ─────────────────────────────────────────────────────────────

async function handleCreateCheckoutSession(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return jsonResponse({ ok: false, error: 'invalid-json' }, 400); }

  const courseId = String(body.course_id || '').trim();
  const currency = String(body.currency || '').trim().toLowerCase();
  const bump = !!body.bump;
  const couponCode = body.coupon ? String(body.coupon).trim().toUpperCase() : null;

  const course = COURSE_CONFIG[courseId];
  if (!course) return jsonResponse({ ok: false, error: 'unknown-course' }, 400);

  const priceRow = course.prices[currency];
  if (!priceRow) return jsonResponse({ ok: false, error: 'unsupported-currency' }, 400);

  // Apply coupon if valid
  let unitAmount = priceRow.unit;
  let appliedCoupon = null;
  if (couponCode) {
    const coupon = COUPONS[couponCode];
    if (coupon && (coupon.applies_to === 'all' || (Array.isArray(coupon.applies_to) && coupon.applies_to.includes(courseId)))) {
      unitAmount = Math.round(unitAmount * (1 - coupon.percent / 100));
      appliedCoupon = couponCode;
    }
  }

  const lineItems = [
    {
      price_data: {
        currency: currency,
        product_data: {
          name: course.name,
          description: course.description
        },
        unit_amount: unitAmount
      },
      quantity: 1
    }
  ];

  if (bump && course.workbook && course.workbook.prices[currency]) {
    lineItems.push({
      price_data: {
        currency: currency,
        product_data: {
          name: course.workbook.name,
          description: course.workbook.description
        },
        unit_amount: course.workbook.prices[currency]
      },
      quantity: 1
    });
  }

  const stripeSecret = env.STRIPE_SECRET_KEY;
  if (!stripeSecret) return jsonResponse({ ok: false, error: 'stripe-not-configured' }, 500);

  const origin = new URL(request.url).origin;
  const successUrl = `${origin}/smm/thank-you/?session_id={CHECKOUT_SESSION_ID}&course=${encodeURIComponent(courseId)}&currency=${encodeURIComponent(currency)}`;
  const cancelUrl = `${origin}/smm/${courseIdToSlug(courseId)}/`;

  // Build Stripe Checkout Session via API
  const form = new URLSearchParams();
  form.append('mode', 'payment');
  form.append('payment_method_types[]', 'card');
  form.append('success_url', successUrl);
  form.append('cancel_url', cancelUrl);
  form.append('customer_creation', 'always');
  form.append('billing_address_collection', 'required');
  form.append('allow_promotion_codes', 'false');
  form.append('metadata[course_id]', courseId);
  form.append('metadata[bump]', bump ? '1' : '0');
  form.append('metadata[coupon]', appliedCoupon || '');
  form.append('metadata[currency]', currency);

  // When workbook bump is in cart, collect shipping address (physical product, shipped).
  // Country list mirrors the geoip-supported markets in the checkout page.
  if (bump) {
    const SHIPPING_COUNTRIES = [
      'GB','IM','JE','GG','US','AU','CA',
      'AT','BE','CY','DE','DK','EE','FI','FR','GR','IS','IE','IT',
      'LV','LT','LU','NL','NO','PT','SK','SI','ES',
      'MY','ZA'
    ];
    SHIPPING_COUNTRIES.forEach(c => form.append('shipping_address_collection[allowed_countries][]', c));
  }
  if (body.affwp_affiliate_id) form.append('metadata[affwp_affiliate_id]', String(body.affwp_affiliate_id));
  if (body.affwp_visit_id) form.append('metadata[affwp_visit_id]', String(body.affwp_visit_id));
  if (body.fbp) form.append('metadata[fbp]', String(body.fbp));
  if (body.fbc) form.append('metadata[fbc]', String(body.fbc));

  lineItems.forEach((li, idx) => {
    form.append(`line_items[${idx}][quantity]`, String(li.quantity));
    form.append(`line_items[${idx}][price_data][currency]`, li.price_data.currency);
    form.append(`line_items[${idx}][price_data][product_data][name]`, li.price_data.product_data.name);
    form.append(`line_items[${idx}][price_data][product_data][description]`, li.price_data.product_data.description);
    form.append(`line_items[${idx}][price_data][unit_amount]`, String(li.price_data.unit_amount));
  });

  try {
    const stripeResp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + stripeSecret,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: form.toString()
    });
    const stripeData = await stripeResp.json();
    if (!stripeResp.ok || !stripeData.url) {
      console.error('[Stripe] Session creation failed:', JSON.stringify(stripeData).substring(0, 500));
      return jsonResponse({ ok: false, error: stripeData.error?.message || 'stripe-error' }, 502);
    }
    return jsonResponse({ ok: true, url: stripeData.url, session_id: stripeData.id });
  } catch (err) {
    console.error('[Stripe] Request failed:', err.message);
    return jsonResponse({ ok: false, error: 'request-failed', message: err.message }, 502);
  }
}

function courseIdToSlug(courseId) {
  const map = {
    'pro-youth-gk': 'pro-youth-goalkeeper-coaching',
    'senior-pro-masters-gk': 'pro-masters-goalkeeper-coaching'
  };
  return map[courseId] || 'pro-youth-goalkeeper-coaching';
}


// ─────────────────────────────────────────────────────────────
// STRIPE PAYMENT INTENT (embedded Elements flow)
// ─────────────────────────────────────────────────────────────

async function handleCreatePaymentIntent(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return jsonResponse({ ok: false, error: 'invalid-json' }, 400); }

  const courseId = String(body.course_id || '').trim();
  const currency = String(body.currency || '').trim().toLowerCase();
  const bump = !!body.bump;
  const couponCode = body.coupon ? String(body.coupon).trim().toUpperCase() : null;
  const email = String(body.email || '').trim();
  const firstName = String(body.first_name || '').trim();
  const lastName = String(body.last_name || '').trim();

  if (!email) return jsonResponse({ ok: false, error: 'missing-email' }, 400);

  const course = COURSE_CONFIG[courseId];
  if (!course) return jsonResponse({ ok: false, error: 'unknown-course' }, 400);
  const basePrice = course.prices[currency];
  if (!basePrice) return jsonResponse({ ok: false, error: 'unsupported-currency' }, 400);

  // Apply coupon
  let unitAmount = basePrice;
  let appliedCoupon = null;
  if (couponCode) {
    const coupon = COUPONS[couponCode];
    if (coupon && (coupon.applies_to === 'all' || (Array.isArray(coupon.applies_to) && coupon.applies_to.includes(courseId)))) {
      unitAmount = Math.round(unitAmount * (1 - coupon.percent / 100));
      appliedCoupon = couponCode;
    }
  }

  // Add bump
  let total = unitAmount;
  let bumpAmount = 0;
  if (bump && course.workbook && course.workbook.prices[currency]) {
    bumpAmount = course.workbook.prices[currency];
    total += bumpAmount;
  }

  const stripeSecret = env.STRIPE_SECRET_KEY;
  if (!stripeSecret) return jsonResponse({ ok: false, error: 'stripe-not-configured' }, 500);

  // Build PaymentIntent request
  const form = new URLSearchParams();
  form.append('amount', String(total));
  form.append('currency', currency);
  form.append('receipt_email', email);
  form.append('description', course.name + (bump ? ' + Workbook' : ''));
  form.append('automatic_payment_methods[enabled]', 'true');
  form.append('automatic_payment_methods[allow_redirects]', 'never');

  // Metadata — read by the webhook to enrol the buyer in WLM
  form.append('metadata[course_id]', courseId);
  form.append('metadata[bump]', bump ? '1' : '0');
  form.append('metadata[coupon]', appliedCoupon || '');
  form.append('metadata[currency]', currency);
  form.append('metadata[email]', email);
  form.append('metadata[first_name]', firstName);
  form.append('metadata[last_name]', lastName);
  form.append('metadata[unit_amount]', String(unitAmount));
  form.append('metadata[bump_amount]', String(bumpAmount));
  if (body.affwp_affiliate_id) form.append('metadata[affwp_affiliate_id]', String(body.affwp_affiliate_id));
  if (body.affwp_visit_id) form.append('metadata[affwp_visit_id]', String(body.affwp_visit_id));
  if (body.fbp) form.append('metadata[fbp]', String(body.fbp));
  if (body.fbc) form.append('metadata[fbc]', String(body.fbc));

  try {
    const resp = await fetch('https://api.stripe.com/v1/payment_intents', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + stripeSecret,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: form.toString()
    });
    const data = await resp.json();
    if (!resp.ok || !data.client_secret) {
      console.error('[Stripe PI] Create failed:', JSON.stringify(data).substring(0, 500));
      return jsonResponse({ ok: false, error: data.error?.message || 'stripe-error' }, 502);
    }
    return jsonResponse({
      ok: true,
      client_secret: data.client_secret,
      payment_intent_id: data.id,
      amount: total,
      currency: currency
    });
  } catch (err) {
    console.error('[Stripe PI] Request failed:', err.message);
    return jsonResponse({ ok: false, error: 'request-failed', message: err.message }, 502);
  }
}


// ─────────────────────────────────────────────────────────────
// PAYPAL (Smart Buttons — create + capture)
// ─────────────────────────────────────────────────────────────

/**
 * PayPal API base. Switch by env.PAYPAL_MODE = 'sandbox' | 'live' (default live).
 */
function paypalBase(env) {
  return (env.PAYPAL_MODE === 'sandbox')
    ? 'https://api-m.sandbox.paypal.com'
    : 'https://api-m.paypal.com';
}

/**
 * Fetch a fresh OAuth access token (valid ~9h, but we don't cache — Worker reqs are short-lived).
 */
async function paypalAccessToken(env) {
  const clientId = env.PAYPAL_CLIENT_ID;
  const clientSecret = env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('paypal-not-configured');
  const resp = await fetch(`${paypalBase(env)}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + btoa(`${clientId}:${clientSecret}`),
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  const data = await resp.json();
  if (!resp.ok || !data.access_token) throw new Error('paypal-auth-failed: ' + JSON.stringify(data).substring(0, 200));
  return data.access_token;
}

/**
 * Build the amount string PayPal expects ("49.00" not 4900 cents).
 * PayPal accepts decimal amounts for currencies it supports.
 */
function paypalAmount(amountSmallestUnit, currency) {
  // For zero-decimal currencies (JPY etc) PayPal doesn't use decimals.
  // The currencies we support (gbp, usd, eur, aud, cad, myr, zar) are all 2-decimal.
  return (amountSmallestUnit / 100).toFixed(2);
}

async function handlePaypalCreateOrder(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return jsonResponse({ ok: false, error: 'invalid-json' }, 400); }

  const courseId = String(body.course_id || '').trim();
  const currency = String(body.currency || '').trim().toLowerCase();
  const bump = !!body.bump;
  const couponCode = body.coupon ? String(body.coupon).trim().toUpperCase() : null;
  const email = String(body.email || '').trim();
  const firstName = String(body.first_name || '').trim();
  const lastName = String(body.last_name || '').trim();

  if (!email) return jsonResponse({ ok: false, error: 'missing-email' }, 400);

  const course = COURSE_CONFIG[courseId];
  if (!course) return jsonResponse({ ok: false, error: 'unknown-course' }, 400);
  const basePrice = course.prices[currency];
  if (!basePrice) return jsonResponse({ ok: false, error: 'unsupported-currency' }, 400);

  // Apply coupon
  let unitAmount = basePrice;
  let appliedCoupon = null;
  if (couponCode) {
    const coupon = COUPONS[couponCode];
    if (coupon && (coupon.applies_to === 'all' || (Array.isArray(coupon.applies_to) && coupon.applies_to.includes(courseId)))) {
      unitAmount = Math.round(unitAmount * (1 - coupon.percent / 100));
      appliedCoupon = couponCode;
    }
  }

  // Build line items
  const items = [{
    name: course.name,
    quantity: '1',
    unit_amount: { currency_code: currency.toUpperCase(), value: paypalAmount(unitAmount, currency) },
    category: 'DIGITAL_GOODS'
  }];

  let bumpAmount = 0;
  if (bump && course.workbook && course.workbook.prices[currency]) {
    bumpAmount = course.workbook.prices[currency];
    items.push({
      name: course.workbook.name,
      quantity: '1',
      unit_amount: { currency_code: currency.toUpperCase(), value: paypalAmount(bumpAmount, currency) },
      category: 'PHYSICAL_GOODS'
    });
  }

  const total = unitAmount + bumpAmount;

  // Build order request
  const purchaseUnit = {
    reference_id: courseId,
    description: course.name + (bump ? ' + Workbook' : ''),
    amount: {
      currency_code: currency.toUpperCase(),
      value: paypalAmount(total, currency),
      breakdown: {
        item_total: { currency_code: currency.toUpperCase(), value: paypalAmount(total, currency) }
      }
    },
    items: items,
    custom_id: [courseId, bump ? '1' : '0', appliedCoupon || '', email].join('|').substring(0, 127)
  };

  const orderRequest = {
    intent: 'CAPTURE',
    purchase_units: [purchaseUnit],
    payment_source: {
      paypal: {
        experience_context: {
          brand_name: 'ISSPF',
          shipping_preference: bump ? 'GET_FROM_FILE' : 'NO_SHIPPING',
          user_action: 'PAY_NOW',
          return_url: 'https://go.isspf.com/smm/thank-you/',
          cancel_url: 'https://go.isspf.com/smm/' + courseIdToSlug(courseId) + '/'
        }
      }
    }
  };

  try {
    const token = await paypalAccessToken(env);
    const resp = await fetch(`${paypalBase(env)}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: JSON.stringify(orderRequest)
    });
    const data = await resp.json();
    if (!resp.ok || !data.id) {
      console.error('[PayPal create] failed:', JSON.stringify(data).substring(0, 500));
      return jsonResponse({ ok: false, error: data.message || 'paypal-create-failed', details: data }, 502);
    }
    return jsonResponse({ ok: true, order_id: data.id, amount: total, currency: currency });
  } catch (err) {
    console.error('[PayPal create] error:', err.message);
    return jsonResponse({ ok: false, error: err.message }, 502);
  }
}

async function handlePaypalCaptureOrder(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return jsonResponse({ ok: false, error: 'invalid-json' }, 400); }
  const orderId = String(body.order_id || '').trim();
  if (!orderId) return jsonResponse({ ok: false, error: 'missing-order-id' }, 400);

  try {
    const token = await paypalAccessToken(env);
    const resp = await fetch(`${paypalBase(env)}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      }
    });
    const data = await resp.json();
    if (!resp.ok) {
      console.error('[PayPal capture] failed:', JSON.stringify(data).substring(0, 500));
      return jsonResponse({ ok: false, error: data.message || 'paypal-capture-failed', details: data }, 502);
    }
    if (data.status !== 'COMPLETED') {
      console.error('[PayPal capture] status not completed:', data.status);
      return jsonResponse({ ok: false, error: 'capture-not-completed', status: data.status }, 502);
    }

    // Parse the custom_id back to metadata
    const unit = data.purchase_units?.[0];
    const custom = (unit?.payments?.captures?.[0]?.custom_id || unit?.custom_id || '').split('|');
    const courseId = custom[0] || '';
    const bump = custom[1] === '1';
    // const coupon = custom[2] || null;
    const email = custom[3] || data.payer?.email_address || '';
    const firstName = data.payer?.name?.given_name || '';
    const lastName = data.payer?.name?.surname || '';
    const name = [firstName, lastName].filter(Boolean).join(' ').trim();

    // Enrol in WishlistMember (same path as the Stripe webhook)
    const enrolResp = await processEnrolment(env, {
      reference_id: orderId,
      course_id: courseId,
      bump: bump,
      email: email,
      name: name
    });
    // processEnrolment already returns a JSON response; we want to add the order details too.
    const enrolJson = await enrolResp.json();

    return jsonResponse({
      ok: enrolJson.ok !== false,
      order_id: orderId,
      capture_id: unit?.payments?.captures?.[0]?.id || null,
      course_id: courseId,
      currency: (unit?.amount?.currency_code || '').toLowerCase(),
      amount: parseFloat(unit?.amount?.value || '0'),
      enrolment: enrolJson
    });
  } catch (err) {
    console.error('[PayPal capture] error:', err.message);
    return jsonResponse({ ok: false, error: err.message }, 502);
  }
}


// ─────────────────────────────────────────────────────────────
// COUPON VALIDATION
// ─────────────────────────────────────────────────────────────

async function handleValidateCoupon(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return jsonResponse({ ok: false, message: 'Invalid request' }, 400); }
  const code = String(body.code || '').trim().toUpperCase();
  const courseId = String(body.course_id || '').trim();
  if (!code) return jsonResponse({ ok: false, message: 'No code provided' }, 400);
  const coupon = COUPONS[code];
  if (!coupon) return jsonResponse({ ok: false, message: 'Code not recognised' });
  if (coupon.expires) {
    const expiresAt = new Date(coupon.expires).getTime();
    if (Date.now() > expiresAt) return jsonResponse({ ok: false, message: 'This code has expired' });
  }
  if (coupon.applies_to !== 'all') {
    const list = Array.isArray(coupon.applies_to) ? coupon.applies_to : [coupon.applies_to];
    if (!list.includes(courseId)) return jsonResponse({ ok: false, message: 'Code not valid for this course' });
  }
  return jsonResponse({ ok: true, percent: coupon.percent, code: code });
}


// ─────────────────────────────────────────────────────────────
// STRIPE WEBHOOK HANDLER (verifies signature + enrols in WLM)
// ─────────────────────────────────────────────────────────────

async function handleStripeWebhook(request, env) {
  const signatureHeader = request.headers.get('stripe-signature') || '';
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('[Stripe webhook] STRIPE_WEBHOOK_SECRET not configured');
    return jsonResponse({ ok: false, error: 'webhook-not-configured' }, 500);
  }

  const rawBody = await request.text();
  const verified = await verifyStripeSignature(signatureHeader, rawBody, webhookSecret);
  if (!verified) {
    console.error('[Stripe webhook] Signature verification failed');
    return new Response('Signature verification failed', { status: 400 });
  }

  let event;
  try { event = JSON.parse(rawBody); } catch (e) {
    return new Response('Invalid JSON', { status: 400 });
  }

  // Handle both flows: Checkout Session (legacy redirect) + PaymentIntent (embedded Elements)
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    return await processEnrolment(env, {
      reference_id: session.id,
      course_id: session.metadata?.course_id,
      bump: session.metadata?.bump === '1',
      email: session.customer_details?.email || session.customer_email,
      name: session.customer_details?.name || ''
    });
  }

  if (event.type === 'payment_intent.succeeded') {
    const intent = event.data.object;
    const md = intent.metadata || {};
    const name = [md.first_name, md.last_name].filter(Boolean).join(' ').trim();
    return await processEnrolment(env, {
      reference_id: intent.id,
      course_id: md.course_id,
      bump: md.bump === '1',
      email: md.email || intent.receipt_email || '',
      name: name
    });
  }

  return jsonResponse({ ok: true, ignored: event.type });
}

/**
 * Shared enrolment handler — used for both Checkout Sessions and PaymentIntents.
 */
async function processEnrolment(env, opts) {
  if (!opts.course_id || !opts.email) {
    console.error('[Stripe webhook] Missing course_id or email', opts.reference_id);
    return jsonResponse({ ok: false, error: 'missing-data' }, 400);
  }

  const course = COURSE_CONFIG[opts.course_id];
  if (!course) {
    console.error('[Stripe webhook] Unknown course_id', opts.course_id);
    return jsonResponse({ ok: false, error: 'unknown-course' }, 400);
  }

  const levelId = env[course.wlm_level_env];
  if (!levelId) {
    console.error('[Stripe webhook] Missing WLM level env var', course.wlm_level_env);
    return jsonResponse({ ok: false, error: 'wlm-level-not-configured' }, 500);
  }

  const workbookLevelEnv = course.workbook?.wlm_level_env;
  const workbookLevelId = workbookLevelEnv ? env[workbookLevelEnv] : null;

  const enrolment = await enrollInWishlistMember(env, {
    email: opts.email,
    name: opts.name,
    levelId: levelId,
    sessionId: opts.reference_id,
    courseId: opts.course_id,
    addWorkbook: opts.bump,
    workbookLevelId: workbookLevelId
  });

  if (!enrolment.ok) {
    console.error('[Stripe webhook] WLM enrolment failed for', opts.reference_id, enrolment.error);
    // Return 200 anyway so Stripe doesn't retry — log internally for manual follow-up
    return jsonResponse({ ok: false, error: 'wlm-enrolment-failed', reference_id: opts.reference_id, message: enrolment.error }, 200);
  }

  return jsonResponse({ ok: true, reference_id: opts.reference_id, wlm_user_id: enrolment.user_id });
}

async function verifyStripeSignature(signatureHeader, rawBody, secret) {
  if (!signatureHeader) return false;
  // Format: t=<timestamp>,v1=<signature>[,v1=<signature2>...]
  const parts = signatureHeader.split(',');
  let timestamp = null;
  const signatures = [];
  for (const part of parts) {
    const [key, value] = part.split('=');
    if (key === 't') timestamp = value;
    if (key === 'v1') signatures.push(value);
  }
  if (!timestamp || signatures.length === 0) return false;

  // Check timestamp within 5 minutes (replay protection)
  const tsNum = parseInt(timestamp, 10);
  if (Math.abs(Date.now() / 1000 - tsNum) > 300) return false;

  const signedPayload = `${timestamp}.${rawBody}`;
  const expected = await hmacSha256Hex(secret, signedPayload);

  // Constant-time compare
  for (const sig of signatures) {
    if (constantTimeEquals(sig, expected)) return true;
  }
  return false;
}

async function hmacSha256Hex(key, message) {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function constantTimeEquals(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}


// ─────────────────────────────────────────────────────────────
// WISHLIST MEMBER ENROLMENT
// ─────────────────────────────────────────────────────────────

/**
 * Enrol a buyer in a WishlistMember level via WLM's API.
 *
 * WLM API documentation: https://wishlistmember.com/wlm-api-overview/
 * The "Add Member" endpoint expects POST to /wlmapi/v1.0/users with form data:
 *   - email (required)
 *   - levels (CSV of level IDs)
 *   - first_name, last_name (optional)
 *   - send_welcome_email (optional, 1/0)
 *
 * Env vars required:
 *   WLM_API_BASE_URL — e.g. https://www.isspf.com/wlmapi/v1.0
 *   WLM_API_KEY      — generated in WLM > Settings > Advanced > API
 */
async function enrollInWishlistMember(env, opts) {
  const apiBase = (env.WLM_API_BASE_URL || '').replace(/\/$/, '');
  const apiKey = env.WLM_API_KEY || '';
  if (!apiBase || !apiKey) {
    return { ok: false, error: 'wlm-not-configured' };
  }

  // Split name into first/last
  const nameParts = (opts.name || '').trim().split(/\s+/);
  const firstName = nameParts[0] || '';
  const lastName = nameParts.slice(1).join(' ') || '';

  // Build levels list (course + workbook if bump)
  // workbookLevelId is now passed in from the caller (course-specific Youth vs Senior workbook)
  const levels = [opts.levelId];
  if (opts.addWorkbook && opts.workbookLevelId) levels.push(opts.workbookLevelId);

  const form = new URLSearchParams();
  form.append('email', opts.email);
  form.append('levels', levels.join(','));
  if (firstName) form.append('first_name', firstName);
  if (lastName) form.append('last_name', lastName);
  form.append('send_welcome_email', '1');
  // Stripe session ID as a custom field for tracking — WLM may or may not store this depending on config
  form.append('custom_field_stripe_session', opts.sessionId);

  try {
    const resp = await fetch(`${apiBase}/users`, {
      method: 'POST',
      headers: {
        'WLM3-API-KEY': apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      },
      body: form.toString()
    });
    const text = await resp.text();
    let data = null;
    try { data = JSON.parse(text); } catch (e) { /* WLM may return non-JSON on error */ }

    if (!resp.ok) {
      console.error('[WLM] API error:', resp.status, text.substring(0, 400));

      // If user already exists, try to add them to the level instead
      if (text.includes('already') || text.includes('exists') || resp.status === 409) {
        return await addExistingUserToLevel(env, opts.email, levels, opts.sessionId);
      }

      return { ok: false, error: 'wlm-api-error', status: resp.status, body: text.substring(0, 200) };
    }

    const userId = data?.user?.id || data?.id || data?.user_id || null;
    return { ok: true, user_id: userId };
  } catch (err) {
    console.error('[WLM] Request failed:', err.message);
    return { ok: false, error: 'wlm-request-failed', message: err.message };
  }
}

/**
 * Fallback when the user already exists in WLM — find them by email, then add the level.
 */
async function addExistingUserToLevel(env, email, levels, sessionId) {
  const apiBase = (env.WLM_API_BASE_URL || '').replace(/\/$/, '');
  const apiKey = env.WLM_API_KEY || '';

  try {
    // Lookup user by email
    const lookupResp = await fetch(`${apiBase}/users?email=${encodeURIComponent(email)}`, {
      headers: { 'WLM3-API-KEY': apiKey, 'Accept': 'application/json' }
    });
    if (!lookupResp.ok) return { ok: false, error: 'wlm-lookup-failed', status: lookupResp.status };
    const lookupData = await lookupResp.json();
    const user = lookupData?.users?.[0] || lookupData?.user || (Array.isArray(lookupData) ? lookupData[0] : null);
    const userId = user?.id || user?.user_id || null;
    if (!userId) return { ok: false, error: 'wlm-user-not-found' };

    // Add each level
    for (const levelId of levels) {
      const addForm = new URLSearchParams();
      addForm.append('level_id', String(levelId));
      const addResp = await fetch(`${apiBase}/users/${userId}/levels`, {
        method: 'POST',
        headers: { 'WLM3-API-KEY': apiKey, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: addForm.toString()
      });
      if (!addResp.ok) {
        const errBody = await addResp.text();
        console.error('[WLM] Add level failed:', addResp.status, errBody.substring(0, 200));
      }
    }
    return { ok: true, user_id: userId, existing: true };
  } catch (err) {
    return { ok: false, error: 'wlm-fallback-failed', message: err.message };
  }
}


// ─────────────────────────────────────────────────────────────
// ORDER SUMMARY (for thank-you page)
// ─────────────────────────────────────────────────────────────

async function handleGetOrderSummary(url, env) {
  const sessionId = url.searchParams.get('session_id') || '';
  if (!sessionId.startsWith('cs_')) return jsonResponse({ ok: false, error: 'invalid-session-id' }, 400);
  const stripeSecret = env.STRIPE_SECRET_KEY;
  if (!stripeSecret) return jsonResponse({ ok: false, error: 'stripe-not-configured' }, 500);

  try {
    const resp = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
      headers: { 'Authorization': 'Bearer ' + stripeSecret }
    });
    if (!resp.ok) {
      const body = await resp.text();
      return jsonResponse({ ok: false, error: 'stripe-fetch-failed', status: resp.status, body: body.substring(0, 200) }, 502);
    }
    const session = await resp.json();
    const courseId = session.metadata?.course_id || '';
    const course = COURSE_CONFIG[courseId];

    return jsonResponse({
      ok: true,
      session_id: session.id,
      amount: (session.amount_total || 0) / 100,
      currency: session.currency || '',
      course_id: courseId,
      course_name: course?.name || '',
      user_data: session.customer_details?.email ? {
        email: session.customer_details.email,
        first_name: (session.customer_details.name || '').split(' ')[0] || undefined,
        last_name: (session.customer_details.name || '').split(' ').slice(1).join(' ') || undefined
      } : null
    });
  } catch (err) {
    return jsonResponse({ ok: false, error: 'request-failed', message: err.message }, 502);
  }
}


// ─────────────────────────────────────────────────────────────
// AFFILIATEWP CONVERSION FOR PURCHASES
// ─────────────────────────────────────────────────────────────

/**
 * Convert an affiliate-tracked visit into a SALE (not opt-in) referral.
 * Called from the thank-you page once Stripe redirects back.
 * Uses the Stripe session amount as the referral amount.
 */
async function handleAffwpConvertSale(request, env, cookies) {
  let body;
  try { body = await request.json(); } catch (e) { return jsonResponse({ ok: false, error: 'invalid-json' }, 400); }
  const sessionId = String(body.session_id || '');
  if (!sessionId.startsWith('cs_')) return jsonResponse({ ok: false, error: 'invalid-session-id' }, 400);

  const affiliateId = cookies['affwp_affiliate_id'];
  const visitId = cookies['affwp_visit_id'];
  if (!affiliateId) return jsonResponse({ ok: true, skipped: 'no-affiliate' });

  const stripeSecret = env.STRIPE_SECRET_KEY;
  if (!stripeSecret) return jsonResponse({ ok: false, error: 'stripe-not-configured' }, 500);

  // Fetch session to get amount
  let amount = 0;
  try {
    const sessionResp = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
      headers: { 'Authorization': 'Bearer ' + stripeSecret }
    });
    if (sessionResp.ok) {
      const session = await sessionResp.json();
      amount = (session.amount_total || 0) / 100;
    }
  } catch (e) { /* continue with amount 0 */ }

  const parentUrl = (env.AFFWP_PARENT_URL || '').replace(/\/$/, '');
  const publicKey = env.AFFWP_PUBLIC_KEY || '';
  const token = env.AFFWP_TOKEN || '';
  if (!parentUrl || !publicKey || !token) return jsonResponse({ ok: false, error: 'affwp-not-configured' }, 500);

  try {
    const apiParams = new URLSearchParams({
      affiliate_id: affiliateId,
      amount: String(amount),
      type: 'sale',
      context: 'gk-course-purchase',
      description: 'GK course purchase via Stripe (' + sessionId + ')',
      status: 'unpaid'
    });
    if (visitId) apiParams.set('visit_id', visitId);

    const apiUrl = `${parentUrl}/wp-json/affwp/v1/referrals?${apiParams.toString()}`;
    const authHeader = 'Basic ' + btoa(`${publicKey}:${token}`);
    const apiResp = await fetch(apiUrl, { method: 'POST', headers: { 'Authorization': authHeader, 'Content-Type': 'application/x-www-form-urlencoded' }, body: '' });
    const text = await apiResp.text();
    if (!apiResp.ok) return jsonResponse({ ok: false, error: 'affwp-api-error', status: apiResp.status, body: text.substring(0, 200) }, 502);
    return jsonResponse({ ok: true, amount: amount });
  } catch (err) {
    return jsonResponse({ ok: false, error: 'request-failed', message: err.message }, 502);
  }
}
