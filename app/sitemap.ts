import type { MetadataRoute } from "next";
import {
  PLANKSPACE_DISCOVERABLE,
  PLANKSPACE_URL,
  SITE_URL,
} from "@/lib/constants";

const routes = [
  { path: "", changeFrequency: "weekly", priority: 1 },
  { path: "/mint", changeFrequency: "weekly", priority: 0.9 },
  { path: "/market", changeFrequency: "daily", priority: 0.9 },
  { path: "/gallery", changeFrequency: "daily", priority: 0.8 },
  ...(PLANKSPACE_DISCOVERABLE
    ? ([{ path: PLANKSPACE_URL, changeFrequency: "daily", priority: 0.8 }] as const)
    : []),
  { path: "/learn", changeFrequency: "monthly", priority: 0.7 },
] as const;

export default function sitemap(): MetadataRoute.Sitemap {
  return routes.map(({ path, changeFrequency, priority }) => ({
    url: `${SITE_URL}${path}`,
    changeFrequency,
    priority,
  }));
}
