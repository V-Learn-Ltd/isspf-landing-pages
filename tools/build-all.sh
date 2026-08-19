#!/usr/bin/env bash
#
# build-all.sh — drop PDFs in a folder, run this, get flipbooks.
#
# THE FOLDER
#   ~/V-Learn Dropbox/ISSPF/Flipbooks-Inbox/
#
# Drop any number of PDFs in there and run:
#   ./tools/build-all.sh
#
# Each PDF becomes a book at go.isspf.com/book/<slug>/ once you push. The slug
# and title come from the filename, so name the file the way you want the title
# to read: "Soccer Load Management.pdf" becomes /book/soccer-load-management/
# titled "Soccer Load Management".
#
# Already-built books are SKIPPED unless the PDF is newer than the build, so
# re-running is cheap and safe. Use --force to rebuild everything.
#
# Titles and CTAs can be overridden per book with a sidecar .conf file next to
# the PDF, same basename:
#
#   Soccer Load Management.conf
#   ------------------------------------------------------------
#   title=Soccer Load Management
#   subtitle=ISSPF · 48 pages
#   cta_text=See The Course
#   cta_url=https://go.isspf.com/smm/load-management/
#   pdf_url=https://www.isspf.com/wp-content/uploads/2026/05/load.pdf
#   ------------------------------------------------------------
#
# This does NOT push. It builds and tells you what changed; you review and push.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INBOX="${FLIPBOOK_INBOX:-$HOME/V-Learn Dropbox/ISSPF/Flipbooks-Inbox}"
FORCE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force)  FORCE=1; shift ;;
    --inbox)  INBOX="$2"; shift 2 ;;
    -h|--help) sed -n '2,40p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

mkdir -p "$INBOX"

shopt -s nullglob nocaseglob
PDFS=("$INBOX"/*.pdf)
shopt -u nocaseglob

if [[ ${#PDFS[@]} -eq 0 ]]; then
  echo "Nothing to do. Drop PDFs into:"
  echo "  $INBOX"
  exit 0
fi

echo "══════════════════════════════════════════════════════"
echo " Flipbook inbox: $INBOX"
echo " Found ${#PDFS[@]} PDF(s)"
echo "══════════════════════════════════════════════════════"

# BSD sed (macOS) has no \+ in basic regex, so -E is required here. Without it
# the separators survive and you get a slug with spaces in it.
slugify() {
  echo "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E -e 's/[^a-z0-9]+/-/g' -e 's/^-+//' -e 's/-+$//'
}

built=(); skipped=(); failed=()

for pdf in "${PDFS[@]}"; do
  base="$(basename "$pdf")"
  name="${base%.*}"
  slug="$(slugify "$name")"
  title="$name"
  subtitle=""; cta_text=""; cta_url=""; pdf_url=""

  conf="${pdf%.*}.conf"
  if [[ -f "$conf" ]]; then
    while IFS='=' read -r k v; do
      k="$(echo "$k" | tr -d '[:space:]')"; v="${v#"${v%%[![:space:]]*}"}"
      case "$k" in
        title)     title="$v" ;;
        subtitle)  subtitle="$v" ;;
        slug)      slug="$(slugify "$v")" ;;
        cta_text)  cta_text="$v" ;;
        cta_url)   cta_url="$v" ;;
        pdf_url)   pdf_url="$v" ;;
      esac
    done < <(grep -vE '^\s*(#|$)' "$conf")
  fi

  out="$REPO_ROOT/book/$slug"

  # 0-byte files are Dropbox online-only placeholders; rendering one yields an
  # empty book. Say so by name rather than failing cryptically later.
  if [[ ! -s "$pdf" ]]; then
    echo; echo "✗ $base"
    echo "   0 bytes — online-only in Dropbox. Right-click in Finder →"
    echo "   'Make Available Offline', wait for it to download, then re-run."
    failed+=("$base (online-only)")
    continue
  fi

  if [[ "$FORCE" -eq 0 && -f "$out/index.html" && ! "$pdf" -nt "$out/index.html" ]]; then
    echo; echo "· $base → /book/$slug/ (already built, unchanged)"
    skipped+=("$slug")
    continue
  fi

  echo; echo "▸ $base → /book/$slug/"
  args=( --pdf "$pdf" --slug "$slug" --title "$title" )
  [[ -n "$subtitle" ]] && args+=( --subtitle "$subtitle" )
  [[ -n "$cta_text" && -n "$cta_url" ]] && args+=( --cta-text "$cta_text" --cta-url "$cta_url" )
  [[ -n "$pdf_url"  ]] && args+=( --pdf-url "$pdf_url" )

  if "$REPO_ROOT/tools/build-flipbook.sh" "${args[@]}" 2>&1 | sed 's/^/   /'; then
    built+=("$slug")
  else
    failed+=("$base")
  fi
done

echo
echo "══════════════════════════════════════════════════════"
echo " Built:   ${#built[@]}   ${built[*]:-}"
echo " Skipped: ${#skipped[@]}   ${skipped[*]:-}"
echo " Failed:  ${#failed[@]}   ${failed[*]:-}"
echo "══════════════════════════════════════════════════════"

if [[ ${#built[@]} -gt 0 ]]; then
  echo
  echo "Review, then publish:"
  echo "  cd \"$REPO_ROOT\""
  echo "  git add book && git commit -m 'Add flipbooks' && git push"
  echo
  echo "They go live at:"
  for s in "${built[@]}"; do echo "  https://go.isspf.com/book/$s/"; done
fi

[[ ${#failed[@]} -eq 0 ]]
