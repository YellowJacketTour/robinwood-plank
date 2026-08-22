"use client";

const PLANKSPACE_SOURCE = "plankspace-wallet-v1";
const PLANK_LOVE_SOURCE = "plank-love-wallet-v1";

export type PlankLoveWalletState = {
  address: string | null;
  chainId: number | null;
  status: "disconnected" | "connecting" | "connected";
  isConnected: boolean;
};

type BridgeMethod =
  | "getState"
  | "connect"
  | "disconnect"
  | "ensureRobinhoodChain"
  | "signMessage";

type BridgeResponse = {
  source: typeof PLANK_LOVE_SOURCE;
  type: "wallet:response";
  requestId: string;
  result?: { state?: PlankLoveWalletState; signature?: string; address?: string };
  error?: string;
};

type BridgeStateMessage = {
  source: typeof PLANK_LOVE_SOURCE;
  type: "wallet:state";
  state: PlankLoveWalletState;
};

const pending = new Map<
  string,
  {
    resolve: (value: NonNullable<BridgeResponse["result"]>) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }
>();

let initialized = false;
let parentOrigin: string | null = null;
const PARENT_ORIGIN_KEY = "plankspace:parent-origin";
let state: PlankLoveWalletState = {
  address: null,
  chainId: null,
  status: "disconnected",
  isConnected: false,
};
const stateListeners = new Set<(value: PlankLoveWalletState) => void>();
function publishState(value: PlankLoveWalletState) {
  state = value;
  stateListeners.forEach(listener => listener(state));
}
export function subscribePlankLoveWalletState(listener:(value:PlankLoveWalletState)=>void){
  stateListeners.add(listener);
  listener(state);
  return () => stateListeners.delete(listener);
}

function resolveParentOrigin() {
  if (typeof window === "undefined" || window.parent === window) return null;
  const configuredParents=(process.env.NEXT_PUBLIC_PLANKSPACE_PARENT_ORIGINS||"")
    .split(",").map(value=>value.trim()).filter(Boolean);
  const trusted=(value:string|null)=>{
    if(!value)return null;
    try{const origin=new URL(value).origin,host=new URL(origin).hostname;
      return host==="plank.love"||host.endsWith(".plank.love")||configuredParents.includes(origin)?origin:null;
    }catch{return null}
  };
  // document.referrer changes to the PlankSpace origin after an internal
  // navigation. ancestorOrigins remains tied to the actual embedding page;
  // sessionStorage preserves the verified value for browsers that omit it.
  const ancestors=(window.location as (Location&{ancestorOrigins?:DOMStringList})|undefined)?.ancestorOrigins;
  const origin=trusted(ancestors?.[0]||null)||trusted(document.referrer)||trusted(sessionStorage.getItem(PARENT_ORIGIN_KEY));
  if(origin)sessionStorage.setItem(PARENT_ORIGIN_KEY,origin);
  return origin;
}

function isBridgeMessage(value: unknown): value is BridgeResponse | BridgeStateMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<BridgeResponse | BridgeStateMessage>;
  return message.source === PLANK_LOVE_SOURCE &&
    (message.type === "wallet:response" || message.type === "wallet:state");
}

function startBridge() {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  parentOrigin = resolveParentOrigin();
  if (!parentOrigin) return;

  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (event.source !== window.parent || event.origin !== parentOrigin || !isBridgeMessage(event.data)) {
      return;
    }
    const message = event.data;
    if (message.type === "wallet:state") {
      publishState(message.state);
      return;
    }
    const request = pending.get(message.requestId);
    if (!request) return;
    clearTimeout(request.timeout);
    pending.delete(message.requestId);
    if (message.error) request.reject(new Error(message.error));
    else request.resolve(message.result || {});
  });

  window.parent.postMessage(
    { source: PLANKSPACE_SOURCE, type: "wallet:ready" },
    parentOrigin
  );
}

function requireBridgeOrigin() {
  startBridge();
  if (!parentOrigin) {
    throw new Error("Open PlankSpace from the Plank.love tab to use its wallet connection.");
  }
  return parentOrigin;
}

async function requestWallet(
  method: BridgeMethod,
  payload?: { address?: string; message?: string }
) {
  const origin = requireBridgeOrigin();
  const requestId = crypto.randomUUID();
  const waitMs = method === "connect" || method === "signMessage" ? 120_000 : 30_000;
  return new Promise<NonNullable<BridgeResponse["result"]>>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error("Plank.love did not finish the wallet request. Try again."));
    }, waitMs);
    pending.set(requestId, { resolve, reject, timeout });
    window.parent.postMessage(
      { source: PLANKSPACE_SOURCE, type: "wallet:request", requestId, method, payload },
      origin
    );
  });
}

export async function getPlankLoveWalletState() {
  const result = await requestWallet("getState");
  if (result.state) publishState(result.state);
  return state;
}

export async function connectPlankLoveWallet() {
  const result = await requestWallet("connect");
  if (result.state) publishState(result.state);
  if (!state.address) throw new Error("Plank.love did not return a connected wallet.");
  return state.address.toLowerCase();
}

export async function ensurePlankLoveRobinhoodChain(address?: string) {
  const result = await requestWallet("ensureRobinhoodChain", { address });
  if (result.state) publishState(result.state);
  return state;
}

export async function signPlankLoveMessage(message: string, address: string) {
  if(!message.startsWith("PlankSpace wallet verification\n")||message.length>2400)throw new Error("PlankSpace rejected an unknown signing request.");
  const result = await requestWallet("signMessage", { message, address });
  if (!result.signature) throw new Error("Plank.love did not return a signature.");
  return result.signature;
}

export async function disconnectPlankLoveWallet() {
  const result = await requestWallet("disconnect");
  if (result.state) publishState(result.state);
  return state;
}

startBridge();
