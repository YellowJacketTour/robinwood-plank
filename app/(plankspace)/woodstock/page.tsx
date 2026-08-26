// Route-segment config must be a literal in the route file itself — Next
// cannot statically read a re-exported `dynamic`. Metadata can be forwarded.
export const dynamic = "force-static";

export { default, metadata } from "@/integrations/plankspace-app/app/woodstock/page";
