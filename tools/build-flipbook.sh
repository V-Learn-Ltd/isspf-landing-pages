#!/usr/bin/env bash
#
# build-flipbook.sh — turn any ISSPF PDF into a page-curl flipbook at
#                     go.isspf.com/book/<slug>/
#
# WHY THIS IS A SCRIPT AND NOT A PAGE
# ISSPF has ~240 PDFs (guidebooks, journals, reports). Hand-building a viewer per
# title would guarantee only one ever gets built. This takes a PDF and emits the
# whole folder — images, manifest, page — so a new title is one command.
#
# WHAT IT PRODUCES
#   book/<slug>/index.html      the reader (chrome + config; logic lives in _lib)
#   book/<slug>/pages/p-NNN.webp      full-size page images
#   book/<slug>/pages/sm/p-NNN.webp   mobile-size page images (srcset)
#
# The PDF itself is NOT copied into the repo by default. Git is a bad home for a
# 24MB binary and Cloudflare Pages caps a single asset at 25MB. Pass --pdf-url to
# point the download button at wherever the PDF already lives (WordPress uploads,
# S3, R2). Use --host-pdf only for small files you want served from this domain.
#
# USAGE
#   # from a folder of page exports instead of a PDF:
#   ./tools/build-flipbook.sh \
#       --images "/path/to/GK_Science_Report_/" \
#       --slug gk-science-report --title "The Goalkeeper Science Report"
#
#   ./tools/build-flipbook.sh \
#       --pdf "/path/to/Report.pdf" \
#       --slug gk-science-report \
#       --title "The Goalkeeper Science Report" \
#       --subtitle "ISSPF · Free 23-page report" \
#       --pdf-url "https://www.isspf.com/wp-content/uploads/2026/04/GK_Science_Report_.pdf" \
#       --cta-text "See The Goalkeeper Courses" \
#       --cta-url  "https://go.isspf.com/smm/pro-youth-checkout/"
#
# REQUIREMENTS: poppler (pdftoppm, pdfinfo) and cwebp.
#   brew install poppler webp

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PDF=""; IMAGES=""; HTML_ONLY=0; SLUG=""; TITLE=""; SUBTITLE=""; PDF_URL=""; HOST_PDF=0
CTA_TEXT=""; CTA_URL=""; BACK_TEXT=""; BACK_URL=""; DESC=""
WIDTH=1600; SMALL_WIDTH=900; ZOOM_WIDTH=2400; QUALITY=82

die() { echo "ERROR: $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pdf)         PDF="$2"; shift 2 ;;
    --images)      IMAGES="$2"; shift 2 ;;
    --slug)        SLUG="$2"; shift 2 ;;
    --title)       TITLE="$2"; shift 2 ;;
    --subtitle)    SUBTITLE="$2"; shift 2 ;;
    --desc)        DESC="$2"; shift 2 ;;
    --pdf-url)     PDF_URL="$2"; shift 2 ;;
    --host-pdf)    HOST_PDF=1; shift ;;
    --html-only)   HTML_ONLY=1; shift ;;
    --cta-text)    CTA_TEXT="$2"; shift 2 ;;
    --cta-url)     CTA_URL="$2"; shift 2 ;;
    --back-text)   BACK_TEXT="$2"; shift 2 ;;
    --back-url)    BACK_URL="$2"; shift 2 ;;
    --width)       WIDTH="$2"; shift 2 ;;
    --zoom-width)  ZOOM_WIDTH="$2"; shift 2 ;;
    --quality)     QUALITY="$2"; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done

if [[ -n "$PDF" && -n "$IMAGES" ]]; then die "pass either --pdf or --images, not both"; fi
if [[ "$HTML_ONLY" -eq 0 && -z "$PDF" && -z "$IMAGES" ]]; then
  die "one of --pdf or --images is required (or --html-only to rewrite the page from existing images)"
fi
[[ -n "$SLUG"  ]] || die "--slug is required"
[[ -n "$TITLE" ]] || die "--title is required"
[[ "$SLUG" =~ ^[a-z0-9-]+$ ]] || die "--slug must be lowercase letters, digits and hyphens"

if [[ "$HTML_ONLY" -eq 0 ]]; then
command -v cwebp >/dev/null || die "cwebp not found — brew install webp"
fi
if [[ -n "$PDF" ]]; then
  command -v pdftoppm >/dev/null || die "pdftoppm not found — brew install poppler"
  command -v pdfinfo  >/dev/null || die "pdfinfo not found — brew install poppler"
  [[ -f "$PDF" ]] || die "PDF not found: $PDF"
elif [[ -n "$IMAGES" ]]; then
  [[ -d "$IMAGES" ]] || die "image directory not found: $IMAGES"
fi

# Dropbox serves most of this library as online-only placeholders that stat as
# 0 bytes. Rendering one produces a silently empty book, so refuse up front and
# say exactly how to fix it.
PDF_BYTES=0
MANIFEST=""

if [[ "$HTML_ONLY" -eq 1 ]]; then
  # Rewrite index.html from the images already rendered. Used to re-stamp the
  # asset version or change a title without paying for a full re-render.
  EXIST="$REPO_ROOT/book/$SLUG/pages"
  [[ -d "$EXIST" ]] || die "--html-only needs book/$SLUG/pages to exist already"
  PAGES=$(ls "$EXIST" | grep -c '\.webp$')
  [[ "$PAGES" -gt 0 ]] || die "no page images in $EXIST"
  FIRST_IMG="$EXIST/p-001.webp"
  SRC_W=$(sips -g pixelWidth  "$FIRST_IMG" 2>/dev/null | awk '/pixelWidth/{print $2}')
  SRC_H=$(sips -g pixelHeight "$FIRST_IMG" 2>/dev/null | awk '/pixelHeight/{print $2}')
  [[ -n "$SRC_W" && -n "$SRC_H" ]] || die "could not read dimensions from $FIRST_IMG"
elif [[ -n "$PDF" ]]; then
  # Dropbox serves most of this library as online-only placeholders that stat as
  # 0 bytes. Rendering one produces a silently empty book, so refuse up front and
  # say exactly how to fix it.
  PDF_BYTES=$(stat -f%z "$PDF" 2>/dev/null || stat -c%s "$PDF")
  if [[ "$PDF_BYTES" -eq 0 ]]; then
    die "'$PDF' is 0 bytes — it is an online-only Dropbox placeholder.
       Right-click the file in Finder and choose 'Make Available Offline', wait
       for it to download, then re-run."
  fi

  PAGES=$(pdfinfo "$PDF" | awk '/^Pages:/ {print $2}')
  [[ "$PAGES" =~ ^[0-9]+$ && "$PAGES" -gt 0 ]] || die "could not read a page count from $PDF"

  # Aspect ratio comes from the source, never hardcoded. A4 guidebooks (1:1.414)
  # and US-Letter reports (1:1.294) are both in this library; using one ratio for
  # both letterboxes or stretches half the catalogue.
  read -r SRC_W SRC_H < <(pdfinfo "$PDF" | awk -F'[ x]+' '/^Page size:/ {print $3, $4}')
else
  # Image-folder source. Most of the ISSPF PDF library is online-only in Dropbox,
  # and several titles exist only as page exports, so this is often the only way
  # in. Export folders also tend to carry "Page 0001-1.jpg" duplicates from repeat
  # export runs; including those would silently triple the book, so they are
  # dropped whenever the un-suffixed original is present.
  MANIFEST="$(mktemp)"
  python3 - "$IMAGES" "$MANIFEST" <<'PYEOF'
import os, re, sys
src, out = sys.argv[1], sys.argv[2]
exts = ('.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff')
names = [f for f in os.listdir(src) if f.lower().endswith(exts) and not f.startswith('.')]

# Drop "<base>-1.jpg" style re-export duplicates when "<base>.jpg" also exists.
have = set(names)
dup = re.compile(r'^(.*)-(\d+)(\.[^.]+)$')
kept = []
for f in names:
    m = dup.match(f)
    if m and (m.group(1) + m.group(3)) in have:
        continue
    kept.append(f)

# Natural sort so Page 2 precedes Page 10.
def key(f):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r'(\d+)', f)]
kept.sort(key=key)

if not kept:
    sys.exit("no image files found in " + src)
with open(out, 'w') as fh:
    for f in kept:
        fh.write(os.path.join(src, f) + "\n")
PYEOF
  PAGES=$(wc -l < "$MANIFEST" | tr -d ' ')
  [[ "$PAGES" -gt 0 ]] || die "no usable images in $IMAGES"

  FIRST_IMG="$(head -1 "$MANIFEST")"
  SRC_W=$(sips -g pixelWidth  "$FIRST_IMG" 2>/dev/null | awk '/pixelWidth/{print $2}')
  SRC_H=$(sips -g pixelHeight "$FIRST_IMG" 2>/dev/null | awk '/pixelHeight/{print $2}')
  [[ -n "$SRC_W" && -n "$SRC_H" ]] || die "could not read dimensions from $FIRST_IMG"

fi

SOURCE_LABEL="${PDF:-$IMAGES}"

PAGE_W=550
PAGE_H=$(python3 -c "print(round($PAGE_W * $SRC_H / $SRC_W))")

OUT="$REPO_ROOT/book/$SLUG"
echo "──────────────────────────────────────────────"
echo " Building flipbook: $SLUG"
echo "   source   : $SOURCE_LABEL"
echo "   pages    : $PAGES"
echo "   page size: ${SRC_W} x ${SRC_H}  →  aspect ${PAGE_W}x${PAGE_H}"
if [[ -n "$IMAGES" ]]; then
  echo "   images   : $(basename "$(head -1 "$MANIFEST")") … $(basename "$(tail -1 "$MANIFEST")")"
fi
echo "   output   : $OUT"
echo "──────────────────────────────────────────────"

if [[ "$HTML_ONLY" -eq 0 ]]; then
rm -rf "$OUT/pages"
mkdir -p "$OUT/pages/sm" "$OUT/pages/xl"
fi
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"; [[ -n "$MANIFEST" ]] && rm -f "$MANIFEST"' EXIT

if [[ "$HTML_ONLY" -eq 1 ]]; then
  echo "→ --html-only: reusing the ${PAGES} page images already on disk"
else
echo "→ rendering ${PAGES} pages at ${SMALL_WIDTH}px, ${WIDTH}px and ${ZOOM_WIDTH}px …"

n=0
m=0

if [[ -n "$PDF" ]]; then
  pdftoppm -png -scale-to-x "$WIDTH"       -scale-to-y -1 "$PDF" "$TMP/lg"
  pdftoppm -png -scale-to-x "$SMALL_WIDTH" -scale-to-y -1 "$PDF" "$TMP/sm"
  pdftoppm -png -scale-to-x "$ZOOM_WIDTH"  -scale-to-y -1 "$PDF" "$TMP/xl"

  # pdftoppm zero-pads to the width of the page count (01.. for 23 pages, 001..
  # for 100+). Normalise to a fixed 3-digit name so the runtime builds URLs blind.
  for f in "$TMP"/lg-*.png; do
    n=$((n + 1)); nn=$(printf '%03d' "$n")
    cwebp -quiet -q "$QUALITY" "$f" -o "$OUT/pages/p-$nn.webp"
  done
  for f in "$TMP"/sm-*.png; do
    m=$((m + 1)); mm=$(printf '%03d' "$m")
    cwebp -quiet -q "$QUALITY" "$f" -o "$OUT/pages/sm/p-$mm.webp"
  done
  x=0
  for f in "$TMP"/xl-*.png; do
    x=$((x + 1)); xx=$(printf '%03d' "$x")
    cwebp -quiet -q "$QUALITY" "$f" -o "$OUT/pages/xl/p-$xx.webp"
  done
else
  while IFS= read -r f; do
    n=$((n + 1)); nn=$(printf '%03d' "$n")
    sips --resampleWidth "$WIDTH"       "$f" --out "$TMP/lg-$nn.png" >/dev/null 2>&1 \
      || die "could not resize $f"
    sips --resampleWidth "$SMALL_WIDTH" "$f" --out "$TMP/sm-$nn.png" >/dev/null 2>&1 \
      || die "could not resize $f"
    sips --resampleWidth "$ZOOM_WIDTH"  "$f" --out "$TMP/xl-$nn.png" >/dev/null 2>&1 \
      || die "could not resize $f"
    cwebp -quiet -q "$QUALITY" "$TMP/lg-$nn.png" -o "$OUT/pages/p-$nn.webp"
    cwebp -quiet -q "$QUALITY" "$TMP/sm-$nn.png" -o "$OUT/pages/sm/p-$nn.webp"
    cwebp -quiet -q "$QUALITY" "$TMP/xl-$nn.png" -o "$OUT/pages/xl/p-$nn.webp"
    rm -f "$TMP/lg-$nn.png" "$TMP/sm-$nn.png" "$TMP/xl-$nn.png"
    printf '\r   %d/%d' "$n" "$PAGES"
  done < "$MANIFEST"
  echo
  m=$n
fi

[[ "$n" -eq "$PAGES" ]] || die "wrote $n page images but the source reports $PAGES pages"
[[ "$m" -eq "$PAGES" ]] || die "wrote $m mobile images but the source reports $PAGES pages"
fi

# Optionally serve the PDF from this domain too.
if [[ "$HOST_PDF" -eq 1 ]]; then
  [[ -n "$PDF" ]] || die "--host-pdf needs --pdf (there is no PDF to host in --images mode)"
  if [[ "$PDF_BYTES" -gt 26214400 ]]; then
    die "--host-pdf refused: $PDF is $((PDF_BYTES / 1048576))MB and Cloudflare Pages
         caps one asset at 25MB. Host it elsewhere and pass --pdf-url."
  fi
  cp "$PDF" "$OUT/$SLUG.pdf"
  PDF_URL="$SLUG.pdf"
  echo "→ hosting PDF locally as $SLUG.pdf"
fi

# ── Extract link annotations ────────────────────────────────────
# The pages are flat images, so any hyperlink baked into the PDF is dead unless
# we put a real <a> back on top of it. The GK Science Report carries its own
# course CTAs this way, so without this the lead magnet's sales links do nothing.
# Rectangles are stored as fractions of the page, so they scale with the book at
# any size and work in the reader and the fallback too.
if [[ "$HTML_ONLY" -eq 0 && -n "$PDF" ]]; then
  python3 - "$PDF" "$OUT/links.json" <<'PYEOF' || echo "   (link extraction skipped: $?)"
import json, sys
try:
    from pypdf import PdfReader
except ImportError:
    sys.stderr.write("pypdf not installed — no links extracted (pip3 install pypdf)\n")
    open(sys.argv[2], "w").write("{}")
    raise SystemExit(0)

src, out = sys.argv[1], sys.argv[2]
links, total = {}, 0
for pno, page in enumerate(PdfReader(src).pages, 1):
    box = page.mediabox
    pw, ph = float(box.width), float(box.height)
    if not pw or not ph:
        continue
    for a in (page.get("/Annots") or []):
        try:
            o = a.get_object()
            if o.get("/Subtype") != "/Link":
                continue
            uri = (o.get("/A") or {}).get("/URI")
            if not uri:
                continue
            x0, y0, x1, y1 = [float(v) for v in o["/Rect"]]
        except Exception:
            continue
        # PDF space is bottom-left origin; the page images are top-left.
        left, right = min(x0, x1) / pw, max(x0, x1) / pw
        top, bottom = 1 - (max(y0, y1) / ph), 1 - (min(y0, y1) / ph)
        if right - left <= 0 or bottom - top <= 0:
            continue
        links.setdefault(str(pno), []).append({
            "x": round(left, 5), "y": round(top, 5),
            "w": round(right - left, 5), "h": round(bottom - top, 5),
            "url": str(uri),
        })
        total += 1
json.dump(links, open(out, "w"), separators=(",", ":"))
print("   links: %d across %d page(s)" % (total, len(links)))
PYEOF
elif [[ "$HTML_ONLY" -eq 0 ]]; then
  echo "{}" > "$OUT/links.json"
  echo "   links: none (image source carries no annotations)"
fi

# ── Cache-bust the shared runtime ───────────────────────────────
# Cloudflare Pages serves these with `max-age=2678400, must-revalidate`, i.e. a
# browser that already has flipbook.js keeps it for 31 days and never asks.
# `must-revalidate` only applies once the max-age has expired, so a fix shipped
# today would not reach a returning reader until September. Stamping a hash of
# the runtime onto the URL changes the URL whenever the code changes, which is
# what actually busts the cache. index.html itself is served max-age=0, so the
# new stamp propagates immediately.
LIB_DIR="$REPO_ROOT/book/_lib"
LIB_VER=$(cat "$LIB_DIR/flipbook.js" "$LIB_DIR/flipbook.css" \
              "$LIB_DIR/page-flip.browser.js" "$LIB_DIR/stpageflip.css" \
          | md5 -q 2>/dev/null || cat "$LIB_DIR/flipbook.js" "$LIB_DIR/flipbook.css" \
              "$LIB_DIR/page-flip.browser.js" "$LIB_DIR/stpageflip.css" | md5sum | cut -d' ' -f1)
LIB_VER="${LIB_VER:0:10}"
echo "→ runtime version: $LIB_VER"

# ── Write index.html ────────────────────────────────────────────
[[ -n "$DESC" ]] || DESC="$TITLE — read it as a flipbook. $PAGES pages, from ISSPF."

DOWNLOAD_BTN=""
if [[ -n "$PDF_URL" ]]; then
  DOWNLOAD_BTN="<a class=\"fb-btn\" href=\"$PDF_URL\" target=\"_blank\" rel=\"noopener\">&#8595; PDF</a>"
fi
CTA_BTN=""
if [[ -n "$CTA_URL" && -n "$CTA_TEXT" ]]; then
  CTA_BTN="<a class=\"fb-btn fb-btn-primary\" href=\"$CTA_URL\">$CTA_TEXT &#8594;</a>"
fi
BACK_BTN=""
if [[ -n "$BACK_URL" && -n "$BACK_TEXT" ]]; then
  BACK_BTN="<a class=\"fb-btn\" href=\"$BACK_URL\">&#8592; $BACK_TEXT</a>"
fi
NOSCRIPT_PDF=""
if [[ -n "$PDF_URL" ]]; then
  NOSCRIPT_PDF=" <a href=\"$PDF_URL\">Download the PDF instead.</a>"
fi

cat > "$OUT/index.html" <<HTMLEOF
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>$TITLE | ISSPF</title>
<meta name="description" content="$DESC" />
<meta name="robots" content="noindex, follow" />

<meta property="og:type" content="article" />
<meta property="og:title" content="$TITLE" />
<meta property="og:description" content="$DESC" />
<meta property="og:image" content="pages/p-001.webp" />

<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Anton&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />

<link rel="stylesheet" href="../_lib/stpageflip.css?v=$LIB_VER" />
<link rel="stylesheet" href="../_lib/flipbook.css?v=$LIB_VER" />

<link rel="preload" as="image" href="pages/p-001.webp" />
</head>
<body>

<header class="fb-bar">
  <div class="fb-brand">
    <span class="fb-title">$TITLE</span>
    <span class="fb-sub">$SUBTITLE</span>
  </div>
  <div class="fb-bar-actions">
    $BACK_BTN
    $DOWNLOAD_BTN
    $CTA_BTN
  </div>
</header>

<main class="fb-stage" id="fb-stage">
  <div class="fb-book-wrap">
    <div class="fb-loading" id="fb-loading">Loading the book&hellip;</div>
    <div id="flipbook" style="visibility:hidden"></div>
  </div>
</main>

<div class="fb-controls" id="fb-controls">
  <button class="fb-btn" id="fb-prev" type="button">&#8249; Prev</button>
  <span class="fb-counter" id="fb-counter">1 / $PAGES</span>
  <button class="fb-btn" id="fb-next" type="button">Next &#8250;</button>
  <button class="fb-btn fb-btn-primary" id="fb-read-open" type="button">&#128269; Read Full Size</button>
</div>

<p class="fb-hint">Click a page or drag its corner to turn it. Use Read Full Size to enlarge the text.</p>

<noscript>
  <p class="fb-note">This reader needs JavaScript.$NOSCRIPT_PDF</p>
</noscript>

<script>
  window.BOOK_CONFIG = {
    slug: "$SLUG",
    pages: $PAGES,
    pagesDir: "pages/",
    ext: "webp",
    pageWidth: $PAGE_W,
    pageHeight: $PAGE_H,
    width: $WIDTH,
    smallPages: true,
    smallWidth: $SMALL_WIDTH,
    zoomWidth: $ZOOM_WIDTH,
    linksUrl: "links.json?v=$LIB_VER"
  };
</script>
<script src="../_lib/page-flip.browser.js?v=$LIB_VER"></script>
<script src="../_lib/flipbook.js?v=$LIB_VER"></script>
</body>
</html>
HTMLEOF

LG_BYTES=$(du -sk "$OUT/pages" | awk '{print $1}')
echo "──────────────────────────────────────────────"
echo " Built  book/$SLUG/"
echo "   $PAGES pages  ·  $(( LG_BYTES / 1024 ))MB of images"
echo "   local preview: (cd \"$REPO_ROOT\" && python3 -m http.server 8788)"
echo "                  http://localhost:8788/book/$SLUG/"
echo "   live (after push): https://go.isspf.com/book/$SLUG/"
echo "──────────────────────────────────────────────"
