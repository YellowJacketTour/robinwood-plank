"use client";

import { useEffect } from "react";

// Measured directly from public/images/plank-logo.webp (1200x1766):
// the eye band sits at rows 543-604, so the vertical center of the
// eyes is at this fraction of the full image height.
const EYE_FRACTION = 573.5 / 1766;

export default function PlankBackground() {
  useEffect(() => {
    const update = () => {
      const pageHeight = document.documentElement.scrollHeight;
      // Width stays locked to 100% (never crops him left-to-right).
      // Height is computed independently (not aspect-locked) so the
      // eye band lands exactly at the real bottom of the page.
      const imgHeight = pageHeight / EYE_FRACTION;
      document.body.style.backgroundSize = `100% 100%, 100% ${imgHeight}px`;
    };

    update();
    // Re-measure after images/fonts finish loading and layout settles.
    const raf1 = requestAnimationFrame(() => requestAnimationFrame(update));
    window.addEventListener("load", update);
    window.addEventListener("resize", update);

    const ro = new ResizeObserver(update);
    ro.observe(document.documentElement);

    return () => {
      cancelAnimationFrame(raf1);
      window.removeEventListener("load", update);
      window.removeEventListener("resize", update);
      ro.disconnect();
    };
  }, []);

  return null;
}
