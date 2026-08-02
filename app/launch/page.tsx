import Home from "../page";
import { createPageMetadata } from "@/lib/seo";

export const metadata = createPageMetadata({
  title: "Launch RobinWood",
  description:
    "Connect a wallet, review the RobinWood mint phases, and mint a Plank NFT on Robinhood Chain.",
  path: "/launch",
  canonicalPath: "/mint",
  keywords: ["RobinWood launch", "RobinWood mint", "Robinhood Chain NFT mint"],
  index: false,
});

export default Home;
