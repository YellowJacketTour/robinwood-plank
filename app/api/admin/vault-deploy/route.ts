import { verifyAdminProof, type AdminProof } from "@/lib/admin-auth";
import { logAdminAction } from "@/lib/admin-log";
import {
  DEFAULT_SHARE_NAME,
  DEFAULT_SHARE_SYMBOL,
  validateVaultDeployInput,
  type VaultDeployInput,
} from "@/lib/market/vault-deploy-v3";
import { publicError, publicJson, rateLimit, readJsonBody } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Dispatches `.github/workflows/deploy-vault-v3.yml` — the gated deploy of
 * MarketplankVaultV3 for a new collection's Instant Swap vault — from the
 * admin Collections section, instead of an admin needing GitHub Actions
 * access themselves.
 *
 * This route is a CALLER of that workflow, not a replacement for its gates:
 * every safety property (mainnet confirmation string, fee ceilings,
 * non-zero mint/redeem, treasury == deploy key, green-gate tests before
 * deploy) lives in the workflow and the contract's constructor, unchanged.
 * This route only forwards validated inputs to GitHub's dispatch API.
 *
 * GET  — public, no secret exposed: reports whether GITHUB_DISPATCH_TOKEN is
 *        configured, so the form can render disabled with a clear reason
 *        instead of failing silently on submit (same pattern as the OpenSea
 *        credential / relayer log path — see app/api/admin/status/route.ts).
 * POST — admin only, fresh wallet signature required every time (no session):
 *        the highest-consequence action in the panel deploys a contract that
 *        will custody real value. The signed payload is the exact validated
 *        input set, so a captured signature can't be replayed against a
 *        different network, fee, or collection.
 */

const GITHUB_API = "https://api.github.com";
const WORKFLOW_FILE = "deploy-vault-v3.yml";
// The repo the workflow lives in. Not a secret — same trust level as any
// other address in this codebase — but broken out as a constant in case the
// repo is ever renamed or forked.
const REPO = process.env.GITHUB_DISPATCH_REPO?.trim() || "YellowJacketTour/robinwood-plank";
// Workflow files only dispatch from a ref that already contains them, so this
// must name a branch where deploy-vault-v3.yml exists. `master` is the
// deployment branch (AGENTS.md) and always has it; a working branch may not,
// and dispatching against a ref without the file fails with a bare 422.
const REF = process.env.GITHUB_DISPATCH_REF?.trim() || "master";

function dispatchToken(): string | null {
  return process.env.GITHUB_DISPATCH_TOKEN?.trim() || null;
}

function githubHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "plank-love-admin",
  };
}

export async function GET() {
  return publicJson({ configured: dispatchToken() !== null });
}

type PostBody = {
  input?: Partial<VaultDeployInput>;
  auth?: Partial<AdminProof>;
};

function normalizeInput(raw: Partial<VaultDeployInput> | undefined): VaultDeployInput {
  return {
    network: raw?.network === "robinhood" ? "robinhood" : "robinhood-testnet",
    confirmation: typeof raw?.confirmation === "string" ? raw.confirmation.trim() : "",
    treasury: typeof raw?.treasury === "string" ? raw.treasury.trim() : "",
    collection: typeof raw?.collection === "string" ? raw.collection.trim() : "",
    // Missing entirely -> the RobinWood default (matches the script's own
    // strEnv fallback); present-but-blank stays blank so validation rejects
    // it rather than silently substituting that default.
    shareName: typeof raw?.shareName === "string" ? raw.shareName.trim() : DEFAULT_SHARE_NAME,
    shareSymbol:
      typeof raw?.shareSymbol === "string" ? raw.shareSymbol.trim() : DEFAULT_SHARE_SYMBOL,
    mintFeeWei: typeof raw?.mintFeeWei === "string" ? raw.mintFeeWei.trim() : "",
    redeemFeeWei: typeof raw?.redeemFeeWei === "string" ? raw.redeemFeeWei.trim() : "",
    targetPremiumWei:
      typeof raw?.targetPremiumWei === "string" ? raw.targetPremiumWei.trim() : "",
    swapFeeBps: typeof raw?.swapFeeBps === "string" ? raw.swapFeeBps.trim() : "",
    seedTokenIds: typeof raw?.seedTokenIds === "string" ? raw.seedTokenIds.trim() : "",
    seedEthWei: typeof raw?.seedEthWei === "string" ? raw.seedEthWei.trim() : "",
    confirmOpen: raw?.confirmOpen === true,
  };
}

/** Best-effort: find the most recently created run for this workflow so the
 * admin gets a direct link instead of having to hunt the Actions tab. GitHub's
 * dispatch endpoint returns 204 with no body, so there is no run id to key
 * off — this is a single lookup (not a poll) right after dispatch, which can
 * legitimately come back empty if GitHub hasn't indexed the run yet. */
async function findLatestRunUrl(token: string): Promise<string | null> {
  try {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const res = await fetch(
      `${GITHUB_API}/repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/runs?event=workflow_dispatch&per_page=1`,
      { headers: githubHeaders(token), cache: "no-store" }
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { workflow_runs?: { html_url?: string }[] };
    return data.workflow_runs?.[0]?.html_url ?? null;
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  try {
    // High-consequence, low-frequency action — a tight limit is a feature,
    // not friction.
    const limited = rateLimit(req, {
      key: "admin-vault-deploy",
      limit: 5,
      windowMs: 10 * 60_000,
    });
    if (limited) return limited;

    const token = dispatchToken();
    if (!token) {
      return publicJson(
        {
          error: "NOT_CONFIGURED",
          message: "GITHUB_DISPATCH_TOKEN is not set on the server.",
        },
        503
      );
    }

    const body = await readJsonBody<PostBody>(req);
    const auth = body.auth;
    if (
      !auth ||
      typeof auth.address !== "string" ||
      typeof auth.signature !== "string" ||
      typeof auth.timestamp !== "number"
    ) {
      return publicJson(
        {
          error: "BAD_AUTH",
          message: "auth requires address, timestamp, and signature.",
        },
        400
      );
    }

    const input = normalizeInput(body.input);
    const problems = validateVaultDeployInput(input);
    if (problems.length > 0) {
      return publicJson(
        {
          error: "BAD_INPUT",
          message: problems.map((p) => `${p.field}: ${p.message}`).join("; "),
          problems,
        },
        400
      );
    }

    // The signed payload is the exact validated input — never trust the
    // client's own validation, and bind the signature to these precise
    // values so it can't be replayed against a different dispatch.
    const payloadJson = JSON.stringify(input);
    const verdict = verifyAdminProof("vault-deploy-dispatch", payloadJson, auth as AdminProof);
    if (!verdict.ok) {
      const status = verdict.error === "UNAUTHORIZED" ? 403 : 401;
      return publicJson(
        {
          error: verdict.error,
          message:
            verdict.error === "STALE"
              ? "Signature expired — sign again."
              : verdict.error === "UNAUTHORIZED"
                ? "This wallet is not an admin."
                : "Signature verification failed.",
        },
        status
      );
    }

    const dispatchRes = await fetch(
      `${GITHUB_API}/repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
      {
        method: "POST",
        headers: {
          ...githubHeaders(token),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ref: REF,
          inputs: {
            network: input.network,
            confirmation: input.confirmation,
            treasury: input.treasury,
            collection: input.collection,
            share_name: input.shareName,
            share_symbol: input.shareSymbol,
            mint_fee_wei: input.mintFeeWei,
            redeem_fee_wei: input.redeemFeeWei,
            target_premium_wei: input.targetPremiumWei,
            swap_fee_bps: input.swapFeeBps,
            seed_token_ids: input.seedTokenIds,
            seed_eth_wei: input.seedEthWei,
            confirm_open: input.confirmOpen,
          },
        }),
      }
    );

    if (!dispatchRes.ok) {
      // GitHub's error body can be verbose; keep the admin-facing message
      // short and never echo the token (it isn't in this response either way).
      const detail = await dispatchRes.text().catch(() => "");
      return publicJson(
        {
          error: "DISPATCH_FAILED",
          message: `GitHub rejected the dispatch (${dispatchRes.status}). ${detail.slice(0, 300)}`,
        },
        502
      );
    }

    await logAdminAction(
      verdict.address,
      "vault-deploy-dispatch",
      `Dispatched deploy-vault-v3.yml: network=${input.network} collection=${input.collection} ` +
        `share="${input.shareName}" (${input.shareSymbol}) ` +
        `treasury=${input.treasury || "(signer default)"} confirmOpen=${input.confirmOpen}`
    );

    const runUrl = await findLatestRunUrl(token);
    return publicJson({
      ok: true,
      runUrl,
      actionsUrl: `https://github.com/${REPO}/actions/workflows/${WORKFLOW_FILE}`,
    });
  } catch (err) {
    return publicError(err, "Unexpected error dispatching the deploy workflow.");
  }
}
