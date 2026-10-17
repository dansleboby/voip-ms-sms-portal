/**
 * Keeps the app the size of what is on screen when a phone's keyboard
 * opens. Chrome and Firefox on Android shrink the page for it
 * (interactive-widget=resizes-content in index.html); Safari only shrinks
 * the visible part and slides the page up, hiding the header and leaving
 * the message box half under the keyboard. Sizing the app to the visible
 * part (--app-height) covers both.
 */
export function fitToVisibleArea(): void {
  const view = window.visualViewport;
  if (!view) return;
  const fit = () => {
    // Pinching to zoom shrinks it too: only follow the keyboard.
    if (Math.abs(view.scale - 1) > 0.01) return;
    document.documentElement.style.setProperty('--app-height', `${Math.round(view.height)}px`);
    if (view.offsetTop > 0) window.scrollTo(0, 0);
  };
  view.addEventListener('resize', fit);
  view.addEventListener('scroll', fit);
  fit();
}
