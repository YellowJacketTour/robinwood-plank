import Image from "next/image";
import type { ReactNode } from "react";
import type { MarketCollection, MarketTab } from "@/lib/market/types";
import styles from "./MarketScaffold.module.css";

const EXPLORER_ADDRESS = "https://robinhoodchain.blockscout.com/address/";

type ScaffoldProps = {
  children: ReactNode;
};

export function MarketScaffold({ children }: ScaffoldProps) {
  return <section className={styles.root}>{children}</section>;
}

export function MarketCollectionHero({ collection }: { collection: MarketCollection }) {
  const shortContract = `${collection.contractAddress.slice(0, 8)}…${collection.contractAddress.slice(-4)}`;

  return (
    <header className={styles.hero}>
      <div className={styles.collectionImage}>
        <Image
          src={collection.image}
          alt={`${collection.name} collection`}
          fill
          sizes="76px"
          className="object-contain p-1.5"
          priority
        />
      </div>
      <div>
        <p className={styles.eyebrow}>Robinhood Chain marketplace</p>
        <div className={styles.titleRow}>
          <h1 className={styles.title}>Marketplank</h1>
          {collection.trustBadges.includes("verified") && (
            <span className={styles.verified} title="Verified collection" aria-label="Verified collection">
              ✓
            </span>
          )}
        </div>
        <p className={styles.description}>
          Buy, sell, bid, or swap RobinWood planks with less hunting and more planking.
        </p>
      </div>
      <div className={styles.heroActions}>
        <a
          className={styles.contractLink}
          href={`${EXPLORER_ADDRESS}${collection.contractAddress}`}
          target="_blank"
          rel="noopener noreferrer"
          title={collection.contractAddress}
        >
          NFT contract {shortContract}
        </a>
      </div>
    </header>
  );
}

export function MarketTabRail({
  navigation,
  actions,
}: {
  navigation: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className={styles.tabRail}>
      <div className={styles.tabNavigation}>{navigation}</div>
      {actions && <div className={styles.tabActions}>{actions}</div>}
    </div>
  );
}

export function MarketContent({ children }: { children: ReactNode }) {
  return <div className={styles.content}>{children}</div>;
}

export function MarketDisclosure({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <details className={styles.disclosure}>
      <summary className={styles.disclosureSummary}>
        <span className={styles.disclosureCopy}>
          <span className={styles.disclosureEyebrow}>{eyebrow}</span>
          <span className={styles.disclosureTitle}>{title}</span>
          <span className={styles.disclosureDescription}>{description}</span>
        </span>
        <span className={styles.disclosureToggle} aria-hidden="true">
          <span className={styles.disclosureClosed}>Open</span>
          <span className={styles.disclosureOpen}>Close</span>
          <span className={styles.disclosureChevron}>⌄</span>
        </span>
      </summary>
      <div className={styles.disclosureBody}>{children}</div>
    </details>
  );
}

export function MarketTabSection({
  eyebrow,
  title,
  description,
  children,
  labelled = true,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
  labelled?: boolean;
}) {
  return (
    <section className={styles.tabSection}>
      {labelled && (
        <header className={styles.sectionHeading}>
          <p className={styles.sectionEyebrow}>{eyebrow}</p>
          <h2 className={styles.sectionTitle}>{title}</h2>
          <p className={styles.sectionDescription}>{description}</p>
        </header>
      )}
      {children}
    </section>
  );
}

export function MarketTabPanel({
  id,
  active,
  children,
}: {
  id: MarketTab;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <div
      id={`market-panel-${id}`}
      role="tabpanel"
      aria-labelledby={`market-tab-${id}`}
      hidden={!active}
    >
      {children}
    </div>
  );
}

export function MarketWalletGate({
  title,
  description,
  onConnect,
}: {
  title: string;
  description: string;
  onConnect: () => void;
}) {
  return (
    <div className="mx-auto max-w-lg rounded-xl border border-gold-500/30 bg-wood-900/90 px-5 py-10 text-center">
      <p className={styles.sectionEyebrow}>Wallet workspace</p>
      <h2 className={`${styles.sectionTitle} mt-1`}>{title}</h2>
      <p className={`${styles.sectionDescription} mx-auto`}>{description}</p>
      <button
        type="button"
        onClick={onConnect}
        className="mt-5 min-h-11 rounded-lg bg-gold-500 px-5 text-sm font-bold text-wood-950 transition hover:bg-gold-400"
      >
        Connect wallet
      </button>
    </div>
  );
}
