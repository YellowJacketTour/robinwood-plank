import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "The Lumberyard — PlankSpace",
  description:
    "Every post, mood change, and knock from wallet-owned boards across PlankSpace on Plank.love.",
  openGraph: {
    title: "The Lumberyard — PlankSpace",
    description: "Pull up a board. Make the space yours.",
  },
};

export { default } from "@/integrations/plankspace-app/app/page";
