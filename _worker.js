/**
 * Cloudflare Pages Worker — A/B routing + AffiliateWP cross-domain tracking
 *
 * Two responsibilities:
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
 * Configuration (wrangler.jsonc vars + Cloudflare dashboard secrets):
 *   AFFWP_PARENT_URL   - https://learn.isspf.com (vars)
 *   AFFWP_REF_VAR      - "a" (vars)
 *   AFFWP_COOKIE_DAYS  - "365" (vars)
 *   AFFWP_CREDIT_LAST  - "false" (vars) — first-touch wins
 *   AFFWP_PUBLIC_KEY   - AffiliateWP REST API public key (secret)
 *   AFFWP_TOKEN        - AffiliateWP REST API token (secret)
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
