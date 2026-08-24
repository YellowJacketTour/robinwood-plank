export const WIDGET_TYPES = ["wallet", "favorite-token", "token-chart", "portfolio", "tip-jar", "custom"] as const;
export type WidgetType = typeof WIDGET_TYPES[number];
export type WidgetStyle = { background: string; opacity: number; borderColor: string; borderWidth: number; borderRadius: number };
export type ProfileWidget = {
  id: number | string;
  type: WidgetType;
  title: string;
  config: Record<string, unknown>;
  style: WidgetStyle;
  sortOrder: number;
  visible: boolean;
  desktopVisible: boolean;
  mobileVisible: boolean;
};
export const widgetLabels: Record<WidgetType, string> = {
  wallet: "Public Wallet", "favorite-token": "Favorite Token", "token-chart": "Token Chart",
  portfolio: "Portfolio", "tip-jar": "Toss a Chip", custom: "Custom Widget",
};
export const defaultWidgetStyle: WidgetStyle = { background: "#f2dfbe", opacity: 1, borderColor: "#9b4d1d", borderWidth: 2, borderRadius: 0 };
export function newWidget(type: WidgetType, id: string): ProfileWidget {
  const config: Record<WidgetType, Record<string, unknown>> = {
    wallet: { addresses: [] },
    "favorite-token": { chain: "ethereum", contract: "", name: "", symbol: "", logoUrl: "", message: "" },
    "token-chart": { provider: "dexscreener", url: "" },
    portfolio: { mode: "hidden", wallets: [], assets: [] },
    "tip-jar": { chainId: 1, chainLabel: "Ethereum", tokenSymbol: "ETH", recipient: "", presets: ["0.001", "0.005", "0.01"], showRecent: true },
    custom: { html: "", css: "" },
  };
  return { id, type, title: widgetLabels[type], config: config[type], style: defaultWidgetStyle, sortOrder: 0, visible: true, desktopVisible: true, mobileVisible: true };
}
