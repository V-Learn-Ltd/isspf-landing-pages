/**
 * fb-click.js — capture the Meta click id, so an ISSPF sale can be matched back to the ad.
 *
 * WHY
 * The Conversions API can only attribute a sale if Meta can recognise the person. Hashed
 * email alone works, but weakly: Meta credits fewer conversions than really happened, so we
 * under-count our own ads and Meta under-bids the audiences that are working. The strong
 * signal is `fbc`, derived from the fbclid Meta appends to every ad click.
 *
 * Measured on production 2026-10-19, GET /api/fb-click/stats on the ISSPF dashboard:
 * totalClickIds 0, withEmail 0, newestCapture null, buyerCoverage 0 of 2 buyers (0%). Urban
 * Sketch on the same day: 38,483 click ids and 171 of 205 buyers linked (83.4%). The
 * dashboard half (the ingest endpoint, the table, the email join) has been live for ISSPF
 * all along. Nothing on go.isspf.com had ever posted to it, and this worker had no
 * /api/fb-click route, so every ISSPF Purchase event went to Meta on email alone.
 *
 * This file is a port of urban-sketch-landing-pages/shared/fb-click.js. Only funnel() and
 * variant() differ, because the paths differ. Deliberately the same mechanism rather than a
 * second one, so there is one thing to understand and one thing to fix.
 *
 * THE JOIN
 * A click id arrives anonymously. The sale arrives later carrying an email. The two are
 * joined at the one moment both are known: when someone types their email in.
 *
 *   ad click  -> /?fbclid=ABC        -> POST /api/fb-click {fbclid}          (anonymous)
 *   opt-in    -> email entered       -> POST /api/fb-click {fbclid, email}   (joined)
 *   purchase  -> payment row w/ email-> getFbcForEmail(email) -> fbc on the CAPI event
 *
 * The anonymous call is worth making on its own: it measures how much ad traffic is
 * arriving, which is how you tell "nobody clicked" apart from "the capture is broken".
 *
 * WHERE THE EMAIL IS ENTERED ON ISSPF
 * Two different shapes, and only one of them is covered by the submit listener below:
 *
 *  - /gk-report/ posts real <form method="post"> opt-ins to arpReach. The capture-phase
 *    submit listener catches those with no page change needed.
 *  - /smm/pro-youth-checkout/ and /smm/pro-masters-checkout/ never submit a form. The card
 *    path is a click handler on #pay-btn driving Stripe Elements, and PayPal renders its own
 *    buttons and calls createOrder straight off a click. Both must call window.vlJoinClick()
 *    explicitly. Urban Sketch lost every PayPal buyer's click id to exactly this.
 *
 * ORDER-OF-LOAD
 * funnel and variant are derived from the path, not from any page config, so this file does
 * not depend on another script having loaded first.
 *
 * This file must never break a page. Every entry point is wrapped, storage access is
 * guarded (Safari private mode throws on localStorage), and every network call swallows its
 * own failure.
 */
(function () {
  var ENDPOINT = '/api/fb-click';
  var KEY = 'vl_fbclid';

  function cookie(name) {
    try {
      var m = document.cookie.match('(^|;)\\s*' + name + '\\s*=\\s*([^;]+)');
      return m ? m.pop() : '';
    } catch (e) { return ''; }
  }

  function stored() { try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; } }

  /**
   * Funnel ids match config/isspf.json defaultFunnels in the dashboard repo — 'free',
   * 'youth', 'masters' — so a captured row groups with everything else about that funnel.
   * Anything else returns '' rather than a guess: a blank funnel is obvious, a wrong one
   * is not.
   */
  function funnel() {
    var p = location.pathname;
    if (p.indexOf('/gk-report') === 0) return 'free';
    if (p.indexOf('/pro-youth-goalkeeper-coaching') === 0
        || p.indexOf('/smm/pro-youth-checkout') === 0) return 'youth';
    if (p.indexOf('/pro-masters-goalkeeper-coaching') === 0
        || p.indexOf('/smm/pro-masters-checkout') === 0) return 'masters';
    return '';
  }

  /**
   * The A/B slot, where there is one. /gk-report is the only path under test (_worker.js
   * AB_TESTS) and the challenger is served at /gk-report/variant-b, so the last segment is
   * the variant. The control is served at /gk-report/ and correctly returns ''.
   */
  function variant() {
    var m = location.pathname.match(/^\/gk-report\/(variant-[^\/]+)\/?$/);
    return m ? m[1].slice(0, 32) : '';
  }

  function post(payload) {
    try {
      // keepalive matters: the opt-in call fires as the page is navigating away, and an
      // ordinary fetch would be cancelled mid-flight at exactly the moment the join is made.
      fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true,
      }).catch(function () {});
    } catch (e) { /* tracking must never break the page */ }
  }

  /**
   * The _fbc cookie is worth more than a reconstructed one: it carries the correct subdomain
   * index and the TRUE click timestamp, neither of which can be recovered from the id alone.
   * But only when it belongs to THIS click.
   *
   * _fbc is `fb.<subdomainIndex>.<timestamp>.<fbclid>`. The pixel rewrites it when it sees a
   * new fbclid, and the pixel is async, so on a fresh click this can still hold the PREVIOUS
   * click's value when we read it. The dashboard's server/fb-click.js:buildFbc() passes any
   * well-formed fbc through, so handing it a stale one files the wrong click id against this
   * visit and quietly damages the match quality this whole thing exists to improve.
   *
   * So: use the cookie only when its trailing id is the id we are reporting. Otherwise send
   * nothing and let the server build `fb.1.<now>.<fbclid>`, which is correct if less precise.
   */
  function fbcFor(id) {
    var c = cookie('_fbc');
    if (!c) return '';
    var parts = c.split('.');
    if (parts.length < 4) return '';
    return parts.slice(3).join('.') === id ? c : '';
  }

  function base(id) {
    return {
      fbclid: id,
      fbc: fbcFor(id),
      fbp: cookie('_fbp'),   // browser id, not click-specific, so it is always safe to send
      url: location.href,
      funnel: funnel(),
      variant: variant(),
    };
  }

  try {
    // 1. LANDING. Persist it: the sale happens on a different page, often days later.
    //    go.isspf.com serves the sales page and the checkout, so one localStorage carries
    //    the click id across the whole funnel.
    var fromUrl = new URLSearchParams(location.search).get('fbclid');
    if (fromUrl) {
      try { localStorage.setItem(KEY, fromUrl); } catch (e) {}
      post(base(fromUrl));
    }

    /**
     * 2. THE JOIN, callable directly. This is the leg that moves buyerCoverage; the
     *    anonymous landing call above only moves totalClickIds.
     *
     * Safe to call repeatedly with the same address: the server upserts on fbclid.
     * Returns false when there is no stored click id, which is the normal case for
     * non-ad traffic and is not an error.
     */
    window.vlJoinClick = function (email) {
      try {
        var id = stored();
        if (!id) return false;                                   // no ad click to attach to
        var e = String(email || '').trim();
        if (!e || e.indexOf('@') === -1) return false;
        var payload = base(id);
        payload.email = e;
        post(payload);
        return true;
      } catch (err) { return false; }
    };

    // 2b. THE JOIN, automatic. Capture phase, so it still runs when a handler further down
    //     cancels the event or rewrites the form — which is what the /gk-report/ track
    //     splitter does. Covers the arpReach opt-in forms. The checkouts submit no form and
    //     call vlJoinClick directly instead.
    document.addEventListener('submit', function (ev) {
      try {
        var id = stored();
        if (!id) return;                       // no ad click to attach this email to
        var form = ev.target;
        if (!form || !form.querySelector) return;
        var field = form.querySelector('input[type=email], input[name*=email i]');
        if (!field || !field.value || field.value.indexOf('@') === -1) return;
        window.vlJoinClick(field.value);
      } catch (e) {}
    }, true);
  } catch (e) {}
})();
