type WalletConnectionState = {
  address: string | null;
  status: "disconnected" | "connecting" | "connected";
  isConnected: boolean;
};

export function walletStateConfirmsDisconnect(state: WalletConnectionState) {
  return state.status === "disconnected" && !state.address && !state.isConnected;
}
