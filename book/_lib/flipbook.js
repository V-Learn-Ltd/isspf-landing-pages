/* ISSPF Flipbook runtime.
 *
 * Generic on purpose: every book on go.isspf.com/book/<slug>/ ships the same
 * three files from /book/_lib/ and differs only by the window.BOOK_CONFIG object
 * written into its index.html by tools/build-flipbook.sh. Adding a title is a
 * build-script run, not a code change.
 *
 * Failure policy: if StPageFlip is missing or throws, we do NOT show a broken
 * viewer. We swap in a plain vertical scroll of the identical page images, which
 * needs no library at all. A reader who came for the report still gets it.
 */
(function () {
  'use strict';

  var cfg = window.BOOK_CONFIG || {};
  var pageCount = cfg.pages | 0;
  var dir = cfg.pagesDir || 'pages/';
  var ext = cfg.ext || 'webp';

  var elStage = document.getElementById('fb-stage');
  var elBook = document.getElementById('flipbook');
  var elLoading = document.getElementById('fb-loading');
  var elPrev = document.getElementById('fb-prev');
  var elNext = document.getElementById('fb-next');
  var elCounter = document.getElementById('fb-counter');
  var elControls = document.getElementById('fb-controls');

  function pad(n) { return String(n).padStart(3, '0'); }
  function srcFor(n, small) { return dir + (small ? 'sm/' : '') + 'p-' + pad(n) + '.' + ext; }

  /* Vertical-scroll fallback. No library, no canvas, no flip. */
  function fallback(reason) {
    if (window.console && reason) console.warn('[flipbook] falling back to scroll view:', reason);
    if (elControls) elControls.style.display = 'none';
    var html = '<div class="fb-note">Showing a simple scrolling view of this book.</div>' +
               '<div class="fb-fallback">';
    for (var i = 1; i <= pageCount; i++) {
      html += '<img src="' + srcFor(i) + '" alt="Page ' + i + ' of ' + pageCount + '"' +
              (i > 2 ? ' loading="lazy"' : '') + ' decoding="async">';
    }
    html += '</div>';
    elStage.innerHTML = html;
  }

  if (!pageCount || !elStage) { fallback('no pages configured'); return; }

  /* Build the page elements StPageFlip will adopt.
   * Cover and back cover get data-density="hard" so they behave as rigid boards
   * rather than bending like paper — the detail that makes it read as a book. */
  var frag = document.createDocumentFragment();
  for (var i = 1; i <= pageCount; i++) {
    var page = document.createElement('div');
    page.className = 'page';
    if (i === 1 || i === pageCount) page.setAttribute('data-density', 'hard');

    var img = document.createElement('img');
    img.alt = 'Page ' + i + ' of ' + pageCount;
    img.decoding = 'async';
    img.src = srcFor(i);
    if (cfg.smallPages) {
      img.srcset = srcFor(i, true) + ' ' + (cfg.smallWidth || 900) + 'w, ' +
                   srcFor(i) + ' ' + (cfg.width || 1600) + 'w';
      img.sizes = '(max-width: 720px) 100vw, 50vw';
    }
    /* The first spread must be painted before the reader looks at it; everything
       past it can wait. Lazy-loading page 1 shows an empty board on open. */
    if (i > 4) img.loading = 'lazy';

    page.appendChild(img);
    frag.appendChild(page);
  }
  elBook.appendChild(frag);

  if (!window.St || !window.St.PageFlip) { fallback('library not loaded'); return; }

  var flip;
  try {
    flip = new window.St.PageFlip(elBook, {
      width: cfg.pageWidth || 550,
      height: cfg.pageHeight || 733,
      size: 'stretch',
      minWidth: 280,
      maxWidth: 1000,
      minHeight: 380,
      maxHeight: 1414,
      drawShadow: true,
      flippingTime: 650,
      usePortrait: true,          /* single page on narrow screens */
      maxShadowOpacity: 0.5,
      showCover: true,
      mobileScrollSupport: true,
      swipeDistance: 30
    });

    flip.loadFromHTML(document.querySelectorAll('#flipbook .page'));
  } catch (err) {
    fallback(err && err.message);
    return;
  }

  document.body.classList.add('fb-locked');

  /* ── Image warming ─────────────────────────────────────────
   * Pages past the opening spread are lazy, which is what keeps the first paint
   * cheap on a 23-page book. But a lazy image only starts loading once it is
   * near the viewport, and StPageFlip stacks every page in the same place — so
   * the page you flip TO can arrive blank and decode a beat later. Warming the
   * pages just ahead of the reader means the paper is always ready before the
   * turn reaches it. */
  var imgs = Array.prototype.slice.call(elBook.querySelectorAll('img'));

  function warm(from, count) {
    for (var i = from; i < from + count && i <= imgs.length; i++) {
      var im = imgs[i - 1];
      if (!im) continue;
      if (im.loading === 'lazy') im.loading = 'eager';
      if (im.decode) im.decode().catch(function () {});
    }
  }

  /* Reveal only once the cover has actually decoded, so nobody sees a white
   * board where the cover should be. The timeout guarantees we never hide the
   * book behind a slow or failed decode. */
  function reveal() {
    var shown = false;
    function show() {
      if (shown) return;
      shown = true;
      if (elLoading) elLoading.remove();
      elBook.style.visibility = 'visible';
    }
    setTimeout(show, 900);
    var first = imgs[0];
    if (first && first.decode) first.decode().then(show).catch(show);
    else show();
  }

  /* ── Fit the book to the viewport ──────────────────────────
   * size:'stretch' computes height from the container width, which on an A4
   * book and a laptop-height window pushes the controls off-screen. So we work
   * backwards: take the height the stage actually has, and cap the wrapper
   * width to the widest book that still fits it. */
  var elWrap = elBook.parentElement;
  var ratio = (cfg.pageHeight || 733) / (cfg.pageWidth || 550);
  var HARD_MAX = 1180;

  /* fit() must CONVERGE, not just compute. Resizing the wrapper and calling
   * flip.update() can re-enter through the library's own resize listener (and
   * through CDP/devtools viewport changes), so an unguarded pair will thrash the
   * renderer until it locks up. Returning false when the width is unchanged
   * makes the second pass a no-op and breaks the cycle. */
  var lastWidth = -1;

  function fit() {
    var cs = window.getComputedStyle(elStage);
    var avail = elStage.clientHeight -
                parseFloat(cs.paddingTop || 0) -
                parseFloat(cs.paddingBottom || 0);
    if (!(avail > 0)) return false;

    var across = 1;
    try { across = flip.getOrientation() === 'portrait' ? 1 : 2; } catch (e) {}

    var w = Math.max(240, Math.min(HARD_MAX, Math.floor((avail / ratio) * across)));
    if (w === lastWidth) return false;

    lastWidth = w;
    elWrap.style.maxWidth = w + 'px';
    return true;
  }

  if (fit()) { try { flip.update(); } catch (e) {} }

  warm(1, 6);
  reveal();

  /* ── Controls ─────────────────────────────────────────────── */
  function render() {
    var current = flip.getCurrentPageIndex() + 1;
    var total = flip.getPageCount();
    if (elCounter) elCounter.textContent = current + ' / ' + total;
    if (elPrev) elPrev.disabled = current <= 1;
    if (elNext) elNext.disabled = current >= total;
  }

  flip.on('flip', function (e) {
    render();
    warm((typeof e.data === 'number' ? e.data : flip.getCurrentPageIndex()) + 1, 4);
  });
  flip.on('changeState', render);
  render();

  if (elPrev) elPrev.addEventListener('click', function () { flip.flipPrev(); });
  if (elNext) elNext.addEventListener('click', function () { flip.flipNext(); });

  document.addEventListener('keydown', function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'ArrowLeft') { flip.flipPrev(); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { flip.flipNext(); e.preventDefault(); }
  });

  /* size:'stretch' recalculates from the container, but only when told to. */
  var t;
  window.addEventListener('resize', function () {
    clearTimeout(t);
    t = setTimeout(function () {
      /* The viewport changed, so the cached width is stale by definition. */
      lastWidth = -1;
      if (fit()) { try { flip.update(); } catch (e) {} }

  warm(1, 6);
  reveal();
    }, 200);
  });
})();
