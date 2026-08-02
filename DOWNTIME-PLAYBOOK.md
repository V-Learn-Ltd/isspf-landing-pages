# www.isspf.com Downtime — Diagnosis Playbook

Written because www.isspf.com keeps dropping intermittently and coming back
on its own. That pattern has a small number of likely causes, and they're
distinguishable in about two minutes if you capture the right thing while
it's happening.

## First: what is and isn't involved

| Host | What it is | Goes down with WordPress? |
|---|---|---|
| **www.isspf.com** | Main WordPress site + WishlistMember | **This is the thing failing** |
| learn.isspf.com | WordPress course/membership area | Yes, if same server |
| go.isspf.com | Static landing pages (this repo, Cloudflare Pages) | No — served from Cloudflare's edge |
| email.isspf.com | arpReach, on DigitalOcean `165.227.107.5` | No — separate box |

Nothing in this repo hosts www.isspf.com. Pushing code here cannot cause or
fix the outage. All the isspf.com hostnames resolve to Cloudflare IPs
(`104.26.12.13`, `104.26.13.13`, `172.67.73.243`), so **www.isspf.com is
proxied through Cloudflare** and the real origin server is hidden behind it.

## The one thing to capture during an outage

Because the site is behind Cloudflare, an outage shows a **Cloudflare error
page with a number on it**. That number identifies the failing layer:

- **521** — origin refused the connection. Web server (nginx/Apache) is down,
  or the host's firewall started blocking Cloudflare's IP ranges.
- **522** — origin never answered in time. **The most common cause of
  intermittent WordPress downtime**: the host is hitting a CPU, RAM, or
  concurrent-process limit and queueing new connections until they expire.
- **523** — origin unreachable. The origin IP in Cloudflare DNS is wrong,
  usually after the host migrated you to a new server.
- **524** — origin answered but took over 100 seconds. A slow database query,
  a runaway `wp-cron`, or one bad plugin doing something expensive.
- **525 / 526** — TLS between Cloudflare and the origin failed. Expired
  origin certificate.
- **"Error establishing a database connection"** — not a Cloudflare page at
  all. MySQL died, almost always from memory exhaustion or
  `max_connections` being hit.
- **502 / 504 without Cloudflare branding** — PHP-FPM fell over at the origin.

**Screenshot whatever appears.** The monitor now records this automatically,
so after a day or two of running you'll have it without needing to catch the
outage live.

## What each finding points to

### 522 or 524 (most likely, given it self-recovers)

This is resource exhaustion, and it self-recovers because load drops and the
queue drains. Work through, in order:

1. **Check the host's resource graphs.** Whoever hosts the origin — cPanel,
   SiteGround, WP Engine, Kinsta, a VPS — has CPU / RAM / "entry process" /
   "I/O" graphs. If you're hitting a ceiling at the same time as the
   outages, that's your answer and the fix is a bigger plan or fewer
   resources consumed.
2. **Look at `wp-cron`.** On a busy site the default WordPress cron fires on
   every page load and can stampede. The standard fix is to disable it in
   `wp-config.php` (`define('DISABLE_WP_CRON', true);`) and run it from a real
   system cron every 5 minutes instead.
3. **Check for a plugin doing scheduled work.** Backup plugins, security
   scanners, and broken-link checkers are repeat offenders. If the outages
   cluster at the same time of day, that's a scheduled job, not traffic.
4. **Check bot traffic.** Cloudflare → Security → Events. A crawler or
   scraper hammering `/?s=` search URLs or WooCommerce endpoints will
   flatten a shared-hosting WordPress site. These bypass page cache by
   design. Cloudflare rate limiting or a WAF rule fixes it.
5. **Rule out MySQL.** Slow queries pile up into connection exhaustion.
   Ask the host for the slow query log.

### "Error establishing a database connection"

MySQL is being killed, usually by the OOM killer. Ask the host to check the
MySQL error log and the system log for out-of-memory events. On a VPS this
often means the server needs more RAM or a swap file.

### 521

Ask the host whether the web server is being restarted or OOM-killed. Also
verify the origin firewall still allows
[Cloudflare's IP ranges](https://www.cloudflare.com/ips/) — some security
plugins and host-level firewalls periodically re-block them.

### 523

The origin IP in Cloudflare's DNS is stale. Get the current origin IP from
the host and update the `www` and `@` A records.

## Useful checks that don't require catching it live

**Cloudflare Analytics** → your zone → Analytics & Logs → look for spikes in
5xx. Cloudflare records the error class even when you weren't watching, and
retains it far longer than you'll remember to check.

**The host's error logs.** PHP error log and web server error log around the
outage timestamps. The monitor's incident list gives you exact timestamps to
search for.

**Query Monitor plugin** (install temporarily) shows slow queries and slow
HTTP calls on the WordPress side.

## Interim mitigation while you chase the root cause

**Turn on Cloudflare Always Online.** Cloudflare → Caching → Configuration →
Always Online. When the origin is down Cloudflare serves a cached copy from
the Internet Archive instead of an error page. It doesn't fix anything, but
visitors and Google see a page rather than a 522.

**Increase Cloudflare's cache aggressiveness for anonymous traffic.** A page
rule or cache rule that caches HTML for logged-out visitors takes a large
share of load off the origin. Be careful to exclude `/wlmapi/`, `wp-admin`,
`wp-login.php`, checkout pages, and anything WishlistMember gates.

## One knock-on effect worth knowing about

When www.isspf.com is down, `_worker.js:1240` deliberately returns HTTP 200
to Stripe after a failed WishlistMember enrolment, so **Stripe never
retries**. A customer who buys during an outage is charged, gets no course
access, and the only trace is a `console.error` in the Cloudflare log that
ages out. There's no queue and no alert.

Not fixed here — flagging it because the monitor's incident timestamps let
you cross-reference Stripe payments against outage windows and manually
enrol anyone who fell through.
