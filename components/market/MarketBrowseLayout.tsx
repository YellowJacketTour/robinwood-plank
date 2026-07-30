"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import styles from "./MarketScaffold.module.css";

type Props = {
  filters: ReactNode;
  lead?: ReactNode;
  toolbar: ReactNode;
  summary: string;
  children: ReactNode;
};

export default function MarketBrowseLayout({
  filters,
  lead,
  toolbar,
  summary,
  children,
}: Props) {
  const [open, setOpen] = useState(false);
  const drawerId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKeyDown);
    closeRef.current?.focus();
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close, open]);

  return (
    <div className={styles.browse}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.filterTrigger}
        aria-expanded={open}
        aria-controls={drawerId}
        onClick={() => setOpen(true)}
      >
        Filters
      </button>

      {open && (
        <button
          type="button"
          className={styles.backdrop}
          aria-label="Close filters"
          onClick={close}
        />
      )}

      <aside
        id={drawerId}
        className={`${styles.filterPanel} ${open ? styles.filterPanelOpen : ""}`}
        aria-label="Marketplace filters"
      >
        <div className={styles.filterHeader}>
          <h3 className={styles.filterTitle}>Filters</h3>
          <button
            ref={closeRef}
            type="button"
            className={styles.filterClose}
            aria-label="Close filters"
            onClick={close}
          >
            ×
          </button>
        </div>
        <div className={styles.filterBody}>{filters}</div>
      </aside>

      <div className={styles.browseMain}>
        {lead && <div className={styles.lead}>{lead}</div>}
        <div className={styles.toolbar}>
          <p className={styles.toolbarSummary}>{summary}</p>
          {toolbar}
        </div>
        {children}
      </div>
    </div>
  );
}
