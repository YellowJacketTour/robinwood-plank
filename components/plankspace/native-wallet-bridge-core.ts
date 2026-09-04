export type NativeWalletState = {
  address: string | null;
  chainId: number | null;
  status: "disconnected" | "connecting" | "connected";
  isConnected: boolean;
};

export type NativeWalletRequest = {
  method?:
    | "getState"
    | "connect"
    | "disconnect"
    | "ensureRobinhoodChain"
    | "signMessage"
    | "sendNativeTransaction";
  payload?: {
    address?: string;
    message?: string;
    to?: string;
    valueHex?: string;
    chainId?: number;
  };
};

export type NativeWalletBridgeDependencies = {
  getState: () => NativeWalletState;
  openConnect: () => void;
  disconnect: () => void;
  ensureRobinhoodChain?: () => Promise<void>;
  signMessage: (message: string, address: string) => Promise<string>;
  sendNativeTransaction: (input: {
    from: string;
    to: string;
    value: string;
  }) => Promise<string>;
};

export async function handleNativePlankSpaceWalletRequest(
  request: NativeWalletRequest,
  dependencies: NativeWalletBridgeDependencies,
) {
  const state = dependencies.getState();

  if (request.method === "getState") return { state };
  if (request.method === "connect") {
    if (state.address) return { state };
    dependencies.openConnect();
    return { pending: true as const };
  }
  if (request.method === "disconnect") {
    dependencies.disconnect();
    return {
      state: {
        address: null,
        chainId: null,
        status: "disconnected" as const,
        isConnected: false,
      },
    };
  }
  if (request.method === "ensureRobinhoodChain") {
    await dependencies.ensureRobinhoodChain?.();
    return { state: dependencies.getState() };
  }
  if (request.method === "signMessage") {
    const activeAddress = state.address?.toLowerCase();
    const requestedAddress = request.payload?.address?.toLowerCase();
    const message = request.payload?.message || "";
    if (!activeAddress || activeAddress !== requestedAddress) {
      throw new Error("Connect the wallet that owns this profile first.");
    }
    if (
      (!message.startsWith("plank:plankspace-session:create:") &&
        !message.startsWith("PlankSpace wallet verification\n")) ||
      message.length > 2400
    ) {
      throw new Error("Rejected an unknown signature request.");
    }
    return {
      signature: await dependencies.signMessage(message, activeAddress),
      address: activeAddress,
    };
  }
  if (request.method === "sendNativeTransaction") {
    const activeAddress = state.address?.toLowerCase();
    const requestedAddress = request.payload?.address?.toLowerCase();
    const to = request.payload?.to || "";
    const value = request.payload?.valueHex || "";
    if (!activeAddress || activeAddress !== requestedAddress) {
      throw new Error("Connect the wallet that owns this profile first.");
    }
    if (!/^0x[a-f0-9]{40}$/i.test(to) || !/^0x[0-9a-f]+$/i.test(value)) {
      throw new Error("Invalid tip transaction details.");
    }
    return {
      txHash: await dependencies.sendNativeTransaction({
        from: activeAddress,
        to,
        value,
      }),
    };
  }
  throw new Error("Unsupported wallet request.");
}

