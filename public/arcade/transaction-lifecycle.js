export const ACTION_STAGES = Object.freeze({
  IDLE: "idle",
  INTENT: "intent",
  SIGNING: "signing",
  SUBMITTED: "submitted",
  INCLUDED: "included",
  ACCEPTED: "accepted",
  REJECTED: "rejected",
  UNKNOWN: "unknown",
});

const ALLOWED = {
  idle: ["intent"],
  intent: ["signing", "submitted", "rejected"],
  signing: ["submitted", "rejected", "unknown"],
  submitted: ["included", "rejected", "unknown"],
  included: ["accepted", "rejected", "unknown"],
  accepted: ["intent"],
  rejected: ["intent"],
  unknown: ["intent", "included", "accepted", "rejected"],
};

export function advanceActionState(current, stage, details = {}) {
  const previous = current?.stage || ACTION_STAGES.IDLE;
  if (!ALLOWED[previous]?.includes(stage)) throw new RangeError(`invalid action transition ${previous} -> ${stage}`);
  return {
    action: String(details.action || current?.action || "transaction"),
    stage,
    hash: details.hash || current?.hash || null,
    blockNumber: details.blockNumber ?? current?.blockNumber ?? null,
    message: String(details.message || ""),
    updatedAt: Date.now(),
  };
}

export function actionStatusText(state) {
  if (!state) return "";
  const action = state.action.toUpperCase();
  return ({
    intent: `${action} REQUESTED`,
    signing: `${action} · CONFIRM IN WALLET`,
    submitted: `${action} · SUBMITTED, NOT YET INCLUDED`,
    included: `${action} · INCLUDED${state.blockNumber === null ? "" : ` IN BLOCK ${state.blockNumber}`}`,
    accepted: `${action} · ACCEPTED BY GAME`,
    rejected: `${action} · REJECTED${state.message ? ` · ${state.message}` : ""}`,
    unknown: `${action} · STATUS UNKNOWN · CHECK HISTORY BEFORE RETRYING`,
  })[state.stage] || "";
}

