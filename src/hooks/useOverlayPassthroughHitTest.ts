import { useEffect } from 'react';

/**
 * Passthrough = full OS click-through. Hover-toggling ignore-mouse was re-blocking
 * the whole BrowserWindow HWND (CSS pointer-events cannot punch holes in it), so
 * folders under the overlay never received clicks.
 *
 * While enabled: mouse always goes to apps underneath; use global hotkeys
 * (Ctrl+1… / Ctrl+Shift+B) to control Pika. This hook only syncs a CSS marker.
 */
export function useOverlayPassthroughHitTest(isPassthrough: boolean): void {
  useEffect(() => {
    const root = document.documentElement;
    if (isPassthrough) {
      root.classList.add('overlay-passthrough');
    } else {
      root.classList.remove('overlay-passthrough');
    }
    return () => root.classList.remove('overlay-passthrough');
  }, [isPassthrough]);
}
