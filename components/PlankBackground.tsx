"use client";

import { useEffect } from "react";

// Source art (public/images/plank-logo.webp, 1200x1766) is split at row 1050:
// plank-head.webp (1200x1050) keeps the face/eyes/smile at true, undistorted
// aspect ratio. plank-legs.webp (1200x716) is the plain lower body/wood grain
// below that — safe to stretch since it has no fine detail to warp.
const HEAD_ASPECT = 1050 / 1200; // height / width, at natural size

export default function PlankBackground() {
  useEffect(() => {
    const update = () => {
      const viewportWidth = document.documentElement.clientWidth;
      const pageHeight = document.documentElement.scrollHeight;
      const headHeight = viewportWidth * HEAD_ASPECT;
      const legsHeight = Math.max(pageHeight - headHeight, 0);

      document.body.style.backgroundSize = `100% 100%, 100% ${headHeight}px, 100% ${legsHeight}px`;
      document.body.style.backgroundPosition = `top center, top center, 50% ${headHeight}px`;
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
