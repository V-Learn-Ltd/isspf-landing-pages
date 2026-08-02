import worker from '../src/index.js';

// ── Fake KV ──────────────────────────────────────────────────
function makeKV() {
  const store = new Map();
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); }
  };
}

// ── Scriptable fetch mock ────────────────────────────────────
let scenario = {};
let sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith('https://api.resend.com') || u.startsWith('https://hooks.example')) {
    sent.push({ url: u, body: JSON.parse(init.body) });
    return new Response('{}', { status: 200 });
  }
  const host = new URL(u).hostname;
  const s = scenario[host];
  if (!s) throw new Error('no scenario for ' + host);
  if (s.throw) {
    const e = new Error(s.throw === 'timeout' ? 'The operation timed out' : 'connection refused');
    e.name = s.throw === 'timeout' ? 'TimeoutError' : 'TypeError';
    throw e;
  }
  if (s.delay) await new Promise(r => setTimeout(r, s.delay));
  return new Response(s.body ?? 'ok', { status: s.status ?? 200 });
};

function makeEnv(kv, extra = {}) {
  return {
    MONITOR: kv,
    TARGETS: JSON.stringify([
      { name: 'www', url: 'https://www.isspf.com/' },
      { name: 'learn', url: 'https://learn.isspf.com/' },
      { name: 'go', url: 'https://go.isspf.com/gk-report/' }
    ]),
    TIMEOUT_MS: '30000',
    SLOW_MS: '300',
    ...extra
  };
}

async function check(env) {
  const r = await worker.fetch(new Request('https://m.dev/check'), env);
  return (await r.json()).results;
}

let pass = 0, fail = 0;
function assert(label, cond, got) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}  →  got: ${JSON.stringify(got)}`); }
}

// ── 1. Classification ────────────────────────────────────────
console.log('\n1. Failure classification');
{
  const kv = makeKV();
  const env = makeEnv(kv);
  scenario = {
    'www.isspf.com':   { status: 522, body: 'cloudflare error' },
    'learn.isspf.com': { status: 200, body: '<html>Error establishing a database connection</html>' },
    'go.isspf.com':    { status: 200, body: 'landing page' }
  };
  const r = await check(env);
  const by = Object.fromEntries(r.map(x => [x.name, x]));
  assert('522 → cloudflare-522, down', by.www.kind === 'cloudflare-522' && by.www.up === false, by.www);
  assert('522 detail names overloaded host', /overloaded host/.test(by.www.detail), by.www.detail);
  assert('HTTP 200 + DB error string → wp-database-down', by.learn.kind === 'wp-database-down' && by.learn.up === false, by.learn);
  assert('healthy → up', by.go.up === true && by.go.kind === 'up', by.go);
}

// ── 2. Cache-busting + no-cache headers ──────────────────────
console.log('\n2. Cache bypass (a cached edge copy must not mask a dead origin)');
{
  const seen = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, init) => { seen.push({ url: String(url), init }); return prev(url, init); };
  const env = makeEnv(makeKV());
  scenario = { 'www.isspf.com': {status:200}, 'learn.isspf.com': {status:200}, 'go.isspf.com': {status:200} };
  await check(env);
  globalThis.fetch = prev;
  assert('probe URL carries _uptime cache-buster', seen.every(s => s.url.includes('_uptime=')), seen[0]?.url);
  assert('sends Cache-Control: no-cache', seen.every(s => s.init.headers['Cache-Control'] === 'no-cache'), seen[0]?.init.headers);
  assert('sets cf.cacheTtl = 0', seen.every(s => s.init.cf?.cacheTtl === 0), seen[0]?.init.cf);
}

// ── 3. Transition-only alerting ──────────────────────────────
console.log('\n3. Alerts fire on transitions only (no spam during a long outage)');
{
  const kv = makeKV();
  const env = makeEnv(kv, {
    RESEND_API_KEY: 'k', ALERT_EMAIL_TO: 'a@b.com,c@d.com', ALERT_EMAIL_FROM: 'alerts@isspf.com'
  });
  scenario = { 'www.isspf.com': {status:200}, 'learn.isspf.com': {status:200}, 'go.isspf.com': {status:200} };
  sent = []; await check(env);
  assert('all-healthy first run sends nothing', sent.length === 0, sent);

  scenario['www.isspf.com'] = { status: 521 };
  sent = []; await check(env);
  assert('up→down sends 1 alert', sent.length === 1, sent.length);
  assert('subject marks DOWN', /🔴 ISSPF DOWN: www/.test(sent[0]?.body.subject), sent[0]?.body.subject);
  assert('recipients split on comma', Array.isArray(sent[0]?.body.to) && sent[0].body.to.length === 2, sent[0]?.body.to);

  sent = []; await check(env);
  assert('still-down sends nothing', sent.length === 0, sent.length);
  sent = []; await check(env);
  assert('still-down again sends nothing', sent.length === 0, sent.length);

  scenario['www.isspf.com'] = { status: 200 };
  sent = []; await check(env);
  assert('down→up sends recovery', sent.length === 1 && /recovered/.test(sent[0].body.subject), sent[0]?.body.subject);
  assert('recovery cites downtime start', /Recovered after being down since 20/.test(sent[0].body.text), sent[0]?.body.text?.slice(0,200));
}

// ── 4. Degraded does not page ────────────────────────────────
console.log('\n4. Degraded (slow but serving) must not page');
{
  const kv = makeKV();
  const env = makeEnv(kv, { ALERT_WEBHOOK_URL: 'https://hooks.example/x', SLOW_MS: '50' });
  scenario = { 'www.isspf.com': {status:200}, 'learn.isspf.com': {status:200}, 'go.isspf.com': {status:200} };
  sent = []; await check(env);
  scenario['www.isspf.com'] = { status: 200, delay: 160 };
  sent = []; const r = await check(env);
  const www = r.find(x => x.name === 'www');
  assert('slow response flagged degraded', www.kind === 'degraded', www.kind);
  assert('degraded still counts as up', www.up === true, www.up);
  assert('degraded sends no alert', sent.length === 0, sent.length);
}

// ── 5. Timeout / unreachable ─────────────────────────────────
console.log('\n5. Network-level failures');
{
  const env = makeEnv(makeKV());
  scenario = {
    'www.isspf.com': { throw: 'timeout' },
    'learn.isspf.com': { throw: 'refused' },
    'go.isspf.com': { status: 200 }
  };
  const r = await check(env);
  const by = Object.fromEntries(r.map(x => [x.name, x]));
  assert('timeout classified', by.www.kind === 'timeout' && by.www.up === false, by.www);
  assert('connection failure classified', by.learn.kind === 'unreachable', by.learn);
  assert('one host failing does not abort the others', by.go.up === true, by.go);
}

// ── 6. Rollups / uptime maths ────────────────────────────────
console.log('\n6. Uptime percentages');
{
  const kv = makeKV();
  const env = makeEnv(kv);
  scenario = { 'www.isspf.com': {status:200}, 'learn.isspf.com': {status:200}, 'go.isspf.com': {status:200} };
  await check(env); await check(env); await check(env);
  scenario['www.isspf.com'] = { status: 522 };
  await check(env);
  const s = await (await worker.fetch(new Request('https://m.dev/status.json'), env)).json();
  const www = s.hosts.find(h => h.name === 'www');
  assert('24h counts 4 checks', www.uptime_24h.checks === 4, www.uptime_24h);
  assert('24h counts 1 failure', www.uptime_24h.failures === 1, www.uptime_24h);
  assert('24h uptime = 75%', Math.abs(www.uptime_24h.pct - 75) < 0.001, www.uptime_24h.pct);
}

// ── 7. Dashboard + token gate ────────────────────────────────
console.log('\n7. Dashboard rendering and auth');
{
  const kv = makeKV();
  const env = makeEnv(kv, { DASHBOARD_TOKEN: 's3cret' });
  scenario = { 'www.isspf.com': {status:524}, 'learn.isspf.com': {status:200}, 'go.isspf.com': {status:200} };

  const denied = await worker.fetch(new Request('https://m.dev/'), env);
  assert('no token → 401', denied.status === 401, denied.status);
  const wrong = await worker.fetch(new Request('https://m.dev/?token=nope'), env);
  assert('wrong token → 401', wrong.status === 401, wrong.status);

  await worker.fetch(new Request('https://m.dev/check?token=s3cret'), env);
  const ok = await worker.fetch(new Request('https://m.dev/?token=s3cret'), env);
  const html = await ok.text();
  assert('correct token → 200', ok.status === 200, ok.status);
  assert('renders 524 explanation', /over 100s/.test(html), html.match(/over 100s[^<]*/)?.[0]);
  assert('marks www card bad', /card bad/.test(html), null);
  assert('shows an incident row', /pill bad/.test(html), null);
  assert('no unescaped template leakage', !/undefined%/.test(html) && !/\[object Object\]/.test(html), null);
}

// ── 8. Malformed config resilience ───────────────────────────
console.log('\n8. Config resilience');
{
  const env = makeEnv(makeKV(), { TARGETS: 'not json{{' });
  scenario = { 'www.isspf.com': {status:200}, 'learn.isspf.com': {status:200}, 'go.isspf.com': {status:200} };
  const r = await check(env);
  assert('bad TARGETS falls back to defaults', r.length === 3, r.length);

  const env2 = makeEnv(makeKV());
  scenario['www.isspf.com'] = { status: 500 };
  sent = [];
  const r2 = await check(env2);           // no alert channel configured at all
  assert('no alert channel → still records, does not throw', r2.find(x=>x.name==='www').kind === 'origin-5xx', r2.find(x=>x.name==='www'));
}

// ── 9. Alert provider failure must not break the loop ────────
console.log('\n9. Alert provider outage');
{
  const kv = makeKV();
  const env = makeEnv(kv, { RESEND_API_KEY: 'k', ALERT_EMAIL_TO: 'a@b.com', ALERT_EMAIL_FROM: 'f@isspf.com' });
  scenario = { 'www.isspf.com': {status:200}, 'learn.isspf.com': {status:200}, 'go.isspf.com': {status:200} };
  await check(env);
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.resend.com')) throw new Error('resend is down');
    return prev(url, init);
  };
  scenario['www.isspf.com'] = { status: 521 };
  let threw = null;
  try { await check(env); } catch (e) { threw = e.message; }
  globalThis.fetch = prev;
  assert('email provider throwing does not break the check', threw === null, threw);
  const state = JSON.parse(kv.store.get('state:www'));
  assert('state still persisted despite alert failure', state.up === false && state.kind === 'cloudflare-521', state);
}

globalThis.fetch = realFetch;
console.log(`\n${'─'.repeat(50)}\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
