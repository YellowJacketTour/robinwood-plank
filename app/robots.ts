import type { MetadataRoute } from "next";
import { PLANKSPACE_DISCOVERABLE, SITE_URL } from "@/lib/constants";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: PLANKSPACE_DISCOVERABLE
        ? "/api/"
        : ["/api/", "/plankspace", "/create-profile", "/profile-editor", "/u/"],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
