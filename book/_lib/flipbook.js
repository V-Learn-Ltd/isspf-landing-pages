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

  /* Link hotspots pulled from the source PDF by tools/build-flipbook.sh.
   * Populated asynchronously; pages already on screen get patched when it lands. */
  var LINKS = {};

  /* Build the anchors for one page into a positioned container.
   * Every link opens in a new tab: the reader is mid-book, and taking them out of
   * it to a course page would lose their place. rel=noopener because target=_blank
   * without it hands the new tab a reference back to this window. */
  function addLinks(container, pageNo) {
    var list = LINKS[String(pageNo)];
    if (!list || !list.length) return;
    if (container.getAttribute('data-links-done') === '1') return;
    container.setAttribute('data-links-done', '1');

    for (var i = 0; i < list.length; i++) {
      var L = list[i];
      var a = document.createElement('a');
      a.className = 'fb-link';
      a.href = L.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.title = L.url;
      a.style.left = (L.x * 100) + '%';
      a.style.top = (L.y * 100) + '%';
      a.style.width = (L.w * 100) + '%';
      a.style.height = (L.h * 100) + '%';

      /* The book turns the page on click, and the library listens on the book
       * itself — so without this a link would navigate AND flip. */
      ['click', 'mousedown', 'pointerdown', 'touchstart'].forEach(function (ev) {
        a.addEventListener(ev, function (e) { e.stopPropagation(); }, { passive: true });
      });

      container.appendChild(a);
    }
  }

  /* Vertical-scroll fallback. No library, no canvas, no flip. */
  function fallback(reason) {
    if (window.console && reason) console.warn('[flipbook] falling back to scroll view:', reason);
    if (elControls) elControls.style.display = 'none';
    var html = '<div class="fb-note">Showing a simple scrolling view of this book.</div>' +
               '<div class="fb-fallback">';
    for (var i = 1; i <= pageCount; i++) {
      html += '<div class="fb-page" data-page="' + i + '">' +
              '<img src="' + srcFor(i) + '" alt="Page ' + i + ' of ' + pageCount + '"' +
              (i > 2 ? ' loading="lazy"' : '') + ' decoding="async"></div>';
    }
    html += '</div>';
    elStage.innerHTML = html;
    loadLinks(function () {
      var wraps = elStage.querySelectorAll('.fb-fallback .fb-page');
      for (var j = 0; j < wraps.length; j++) {
        addLinks(wraps[j], parseInt(wraps[j].getAttribute('data-page'), 10));
      }
    });
  }

  function loadLinks(then) {
    if (!cfg.linksUrl) { then && then(); return; }
    fetch(cfg.linksUrl, { cache: 'force-cache' })
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (j) { LINKS = j || {}; })
      .catch(function () { LINKS = {}; })
      .then(function () { then && then(); });
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
  var HARD_MAX = 2000;   /* a 1000px page still downsamples from the 1600px tier */

  /* Size the book to the WIDTH available and let the page scroll if the result
   * is taller than the viewport. An earlier version fitted the whole spread on
   * screen so the controls never moved, but that made the book about 70% of the
   * width it could have been, which is the single biggest thing you notice.
   * The controls stay reachable by sticking to the bottom instead.
   *
   * fit() must CONVERGE, not just compute: changing the wrapper width and
   * calling flip.update() can re-enter through the library's own resize
   * listener, and an unguarded pair thrashes the renderer until it locks up.
   * Returning false when the width is unchanged breaks that cycle. */
  var lastWidth = -1;

  function fit() {
    var cs = window.getComputedStyle(elStage);
    var avail = elStage.clientWidth -
                parseFloat(cs.paddingLeft || 0) -
                parseFloat(cs.paddingRight || 0);
    if (!(avail > 0)) return false;

    var w = Math.max(240, Math.min(HARD_MAX, Math.floor(avail)));
    if (w === lastWidth) return false;

    lastWidth = w;
    elWrap.style.maxWidth = w + 'px';
    return true;
  }

  if (fit()) { try { flip.update(); } catch (e) {} }

  warm(1, 6);
  reveal();

  /* Pages are already in the DOM, so patch them all as soon as the links land. */
  loadLinks(function () {
    var pages = elBook.querySelectorAll('.page');
    for (var i = 0; i < pages.length; i++) addLinks(pages[i], i + 1);
    if (read.open) applyReadLinks();
  });

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

    if (read.open) {
      if (e.key === 'Escape') { closeRead(); e.preventDefault(); }
      else if (e.key === 'ArrowLeft') { gotoRead(read.page - 1); e.preventDefault(); }
      else if (e.key === 'ArrowRight') { gotoRead(read.page + 1); e.preventDefault(); }
      else if (e.key === '+' || e.key === '=') { stepZoom(1); e.preventDefault(); }
      else if (e.key === '-') { stepZoom(-1); e.preventDefault(); }
      return;
    }

    if (e.key === 'ArrowLeft') { flip.flipPrev(); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { flip.flipNext(); e.preventDefault(); }
    else if (e.key === 'Enter') { openRead(flip.getCurrentPageIndex() + 1); e.preventDefault(); }
  });

  /* ══════════════════════════════════════════════════════════
   * READ MODE
   * The flip view exists to make the book feel like an object. It cannot also
   * be the place you read it: a whole A4 spread fitted to a laptop screen puts
   * body text at ~9px. So reading gets its own view — one page, full width,
   * scrolled vertically, using the 2400px tier so it stays sharp when enlarged.
   * ══════════════════════════════════════════════════════════ */

  var read = {
    el: null, img: null, figure: null, scroll: null, counter: null,
    page: 1, zoom: 1, open: false
  };

  /* The figure is sized by the image, so hotspot percentages land correctly at
   * any zoom level without recomputing anything. */
  function applyReadLinks() {
    if (!read.figure) return;
    var old = read.figure.querySelectorAll('.fb-link');
    for (var i = 0; i < old.length; i++) old[i].remove();
    read.figure.removeAttribute('data-links-done');
    addLinks(read.figure, read.page);
  }

  var ZOOM_STEPS = [1, 1.5, 2, 3];

  function readSrc(n) {
    return cfg.zoomWidth ? dir + 'xl/p-' + pad(n) + '.' + ext : srcFor(n);
  }

  function buildRead() {
    var el = document.createElement('div');
    el.className = 'fb-read';
    el.innerHTML =
      '<div class="fb-read-bar">' +
        '<button class="fb-btn" data-act="prev" type="button">&#8249; Prev</button>' +
        '<span class="fb-counter" data-el="counter"></span>' +
        '<button class="fb-btn" data-act="next" type="button">Next &#8250;</button>' +
        '<span class="fb-read-spacer"></span>' +
        '<button class="fb-btn" data-act="out" type="button" aria-label="Zoom out">&#8722;</button>' +
        '<button class="fb-btn" data-act="in" type="button" aria-label="Zoom in">+</button>' +
        '<button class="fb-btn fb-btn-primary" data-act="close" type="button">Close &#10005;</button>' +
      '</div>' +
      '<div class="fb-read-scroll" data-el="scroll">' +
        '<div class="fb-read-figure" data-el="figure"><img alt=""></div>' +
      '</div>';
    document.body.appendChild(el);

    read.el = el;
    read.img = el.querySelector('img');
    read.figure = el.querySelector('[data-el="figure"]');
    read.scroll = el.querySelector('[data-el="scroll"]');
    read.counter = el.querySelector('[data-el="counter"]');

    el.addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]');
      if (!b) return;
      var a = b.getAttribute('data-act');
      if (a === 'close') closeRead();
      else if (a === 'prev') gotoRead(read.page - 1);
      else if (a === 'next') gotoRead(read.page + 1);
      else if (a === 'in') stepZoom(1);
      else if (a === 'out') stepZoom(-1);
    });

    /* Re-fit on resize, but only while open. */
    window.addEventListener('resize', function () { if (read.open) applyZoom(); });
    return el;
  }

  /* Width at zoom 1 = fit the scroller, capped at the source width so we never
   * upscale past the pixels we actually have. */
  function baseWidth() {
    var cs = window.getComputedStyle(read.scroll);
    var inner = read.scroll.clientWidth -
                parseFloat(cs.paddingLeft || 0) - parseFloat(cs.paddingRight || 0);
    return Math.max(240, Math.min(inner, cfg.zoomWidth || cfg.width || 1600));
  }

  function applyZoom() {
    var w = Math.round(baseWidth() * read.zoom);
    read.img.style.width = w + 'px';
    if (read.figure) read.figure.style.width = w + 'px';
  }

  function stepZoom(dir2) {
    var i = ZOOM_STEPS.indexOf(read.zoom);
    if (i < 0) i = 0;
    i = Math.max(0, Math.min(ZOOM_STEPS.length - 1, i + dir2));
    read.zoom = ZOOM_STEPS[i];
    applyZoom();
  }

  function gotoRead(n) {
    if (n < 1 || n > pageCount) return;
    read.page = n;
    read.img.src = readSrc(n);
    read.img.alt = 'Page ' + n + ' of ' + pageCount;
    read.counter.textContent = n + ' / ' + pageCount;
    read.scroll.scrollTop = 0;
    applyZoom();
    applyReadLinks();
    read.el.querySelector('[data-act="prev"]').disabled = n <= 1;
    read.el.querySelector('[data-act="next"]').disabled = n >= pageCount;
  }

  function openRead(n) {
    if (!read.el) buildRead();
    read.open = true;
    read.zoom = 1;
    read.el.classList.add('is-open');
    document.body.classList.add('fb-reading');
    gotoRead(n);
  }

  function closeRead() {
    if (!read.el) return;
    read.open = false;
    read.el.classList.remove('is-open');
    document.body.classList.remove('fb-reading');
    /* Land the book on whatever page was last being read. */
    try { flip.turnToPage(read.page - 1); } catch (e) {}
  }

  /* Read mode is opened by the button (or Enter), NEVER by clicking a page.
   *
   * An earlier version opened it on any click that did not drag. That quietly
   * stole StPageFlip's own click-to-turn: clicking a page magnified it instead
   * of turning it, and since the handler was always live, closing the reader and
   * clicking again just reopened it. It felt like a trap with no way out.
   * Clicking a page must do the one thing a book does when you click it. */

  var elRead = document.getElementById('fb-read-open');
  if (elRead) elRead.addEventListener('click', function () {
    openRead(flip.getCurrentPageIndex() + 1);
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

  /* Pages are already in the DOM, so patch them all as soon as the links land. */
  loadLinks(function () {
    var pages = elBook.querySelectorAll('.page');
    for (var i = 0; i < pages.length; i++) addLinks(pages[i], i + 1);
    if (read.open) applyReadLinks();
  });
    }, 200);
  });
})();
