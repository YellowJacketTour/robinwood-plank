"use client";

import { useEffect } from "react";
import { registerArtServiceWorker } from "@/lib/art-cache";

/** Registers the art-only SW after first paint. Safe no-op without SW support. */
export default function ArtServiceWorker() {
  useEffect(() => {
    registerArtServiceWorker();
  }, []);
  return null;
}
