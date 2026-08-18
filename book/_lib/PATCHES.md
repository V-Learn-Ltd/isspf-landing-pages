# Local patches to `page-flip.browser.js`

StPageFlip 2.0.7 (MIT) is vendored here rather than loaded from a CDN. Two
patches are applied to the vendored bundle, both to `UI.onTouchStart` /
`UI.onTouchMove`. **Re-apply them after any upgrade** or the mobile double-turn
returns. Search for `startUserTouch` to find both sites.

## The bug they fix

Reported as "when you tap it on mobile to flick a page, it jumps back before
turning the page".

`onTouchStart` scheduled a fold on a timer:

```js
setTimeout(() => { null !== this.touchPoint && this.app.startUserTouch(i) }, this.swipeTimeout)
```

`swipeTimeout` is hardcoded to 250ms in the UI constructor and is not exposed as
a setting. Rest a finger on the page for longer than that — an ordinary phone tap
— and a fold begins. Lifting is not a swipe, so the library completes that fold
immediately (a 5ms "flip"), and then flip-by-click turns a **second** page.
Measured at 390x844, starting from page 3:

| finger down | before | after |
|---|---|---|
| 120ms | 3 → 4 | 3 → 4 |
| 300ms | 3 → **5** | 3 → 4 |
| 500ms | 3 → **5** | 3 → 4 |
| 800ms | 3 → **5** | 3 → 4 |

The visible "jump back" is the fold snapping shut; the skipped page is the click
that follows it.

## Patch 1 — do not begin a fold on a timer

`this.swipeTimeout` → `1200` in that one `setTimeout` call. Only the fold delay
changes; `swipeTimeout` itself is untouched, so swipe detection still uses 250ms.

## Patch 2 — begin the fold on movement instead

Deleting the timer alone is not enough, and doing only that breaks dragging: the
timer was also the only thing that put the book into a folding state, so
`onTouchMove` had nothing to move. In `onTouchMove`:

```js
… && t.cancelable && this.app.userMove(i, !0)
```
becomes
```js
… && t.cancelable && ("read" === this.app.getState() && this.app.startUserTouch(this.touchPoint.point), this.app.userMove(i, !0))
```

so the fold starts from the original touch point as soon as the finger has
travelled more than 10px. Drag-to-fold now responds to movement rather than to
time, which is what it should always have keyed on.

## Verified

Held taps at 120 / 300 / 500 / 800ms all produce exactly one turn. Swipes work in
both directions and are now correct: on the pristine bundle a right-to-left swipe
and a left-to-right swipe both went *forward*; they now go forward and back
respectively.

**Not verified in the harness:** finger-drag-to-fold. CDP-synthesised `touchmove`
events are not `cancelable`, and the library guards the fold path with
`t.cancelable`, so that path cannot be driven synthetically. The equivalent mouse
path (`mousedown`/`mousemove`/`mouseup` → `userMove`/`userStop`) is covered by the
desktop drag test and passes. Worth a check on a real phone.
