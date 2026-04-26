/**
 * Cloudflare Pages Worker — A/B routing for ISSPF landing pages
 *
 * Behaviour
 * - On any /<campaign>/ path that has an active A/B test (see AB_TESTS below):
 *   - Read variant from cookie (sticky assignment per visitor).
 *   - If no cookie, assign 50/50 random and set cookie for 90 days.
 *   - Rewrite the request to serve either index.html (variant A / control)
 *     or variant-b.html (variant B / challenger).
 *   - Add X-AB-Variant response header so we can verify in DevTools / logs.
 * - All other paths (assets, other pages) pass through to static asset serving.
 *
 * To add a new test
 * - Add an entry to AB_TESTS with the path (no trailing slash, no .html).
 * - Drop variant-b.html alongside index.html in the campaign folder.
 * - Push.
 *
 * To call a winner / kill a test
 * - Remove the entry from AB_TESTS. All traffic goes back to index.html (A).
 * - Optionally promote variant-b.html → index.html (rename) to make B the new control.
 */

const AB_TESTS = {
  // path (without trailing slash) → cookie name
  '/gk-report': 'ab_gk_report',
};

const VARIANT_COOKIE_MAX_AGE = 60 * 60 * 24 * 90; // 90 days

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, ''); // strip trailing slash

    // Check if this path has an active A/B test
    const cookieName = AB_TESTS[path];
    if (!cookieName) {
      // Not a test path — pass through to static assets
      return env.ASSETS.fetch(request);
    }

    // Read existing variant from cookie if present
    const cookieHeader = request.headers.get('cookie') || '';
    const cookieMatch = cookieHeader.match(new RegExp(`${cookieName}=([ab])`));
    let variant = cookieMatch ? cookieMatch[1] : null;

    // Assign new variant 50/50 if no cookie
    const isNewAssignment = !variant;
    if (isNewAssignment) {
      variant = Math.random() < 0.5 ? 'a' : 'b';
    }

    // Rewrite path to the variant. CRITICAL: use canonical / extensionless paths.
    // Cloudflare Pages 308-redirects /foo/index.html → /foo/ and /foo/variant-b.html → /foo/variant-b.
    // If we fetch the .html form, Pages returns a 308 which our Worker propagates to the client,
    // and the client's redirect-follow re-triggers our Worker → infinite loop.
    // Use the canonical URL form: /<path>/ for the directory's default (serves index.html),
    // /<path>/variant-b extensionless for the challenger.
    const targetPath = variant === 'b' ? `${path}/variant-b` : `${path}/`;
    const rewriteUrl = new URL(targetPath, url.origin);
    const rewriteRequest = new Request(rewriteUrl.toString(), request);

    // Fetch the static asset (this call bypasses the Worker, no recursion risk).
    const response = await env.ASSETS.fetch(rewriteRequest);

    // Build new response so we can attach headers
    const newResponse = new Response(response.body, response);

    // Set/refresh the variant cookie (sticky assignment)
    if (isNewAssignment) {
      newResponse.headers.append(
        'set-cookie',
        `${cookieName}=${variant}; Path=/; Max-Age=${VARIANT_COOKIE_MAX_AGE}; SameSite=Lax; Secure`
      );
    }

    // Diagnostic header — shows which variant served (visible in DevTools / Clarity)
    newResponse.headers.set('x-ab-variant', variant);
    newResponse.headers.set('x-ab-test', cookieName);

    return newResponse;
  },
};
