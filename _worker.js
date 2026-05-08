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
