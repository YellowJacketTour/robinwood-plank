"use client";

import { Component, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { hasError: boolean };

/**
 * Defensive boundary around PlankPriceChart (a component this page mounts
 * but does not own/edit — see app/trade/page.tsx). Price context is
 * supporting information, not the primary task on /trade (DESIGN.md: each
 * page leads with its primary task); a chart-library exception must never
 * take the whole trade workbench down with it. React error boundaries only
 * catch render/commit-phase errors, which covers the observed failure mode
 * (an uncaught throw inside the chart's data-effect) — this is a generic,
 * chart-agnostic safety net, not a workaround for the specific bug.
 */
export default class ChartErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    console.error("[trade] price chart failed to render:", error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-[120px] items-center justify-center rounded-xl border border-line bg-panel p-3 text-center text-xs text-cream-muted">
          Price chart is temporarily unavailable — the trade widget below still works normally.
        </div>
      );
    }
    return this.props.children;
  }
}
