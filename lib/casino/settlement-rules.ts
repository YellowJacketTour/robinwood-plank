/**
 * Settlement-rule version registry + commitment-time persistence.
 *
 * PRINCIPLE: a round settles — and forever REPLAYS — under the rule and
 * parameters that were persisted AT ROUND COMMITMENT, never under whatever the
 * current configuration happens to be. Historical PFSS rounds therefore always
 * replay as pfss (version 1), even after "ccs-2l" became selectable.
 *
 * The registry maps (rule, version) to a FROZEN settle implementation and a
 * deterministic parameter hash:
 *  - "ccs-2l" v1: paramsHash = keccak256(abi.encode(keccak256("ccs-2l"), 1,
 *    floorBps, houseCapBps)) — byte-identical to
 *    contracts/lib/PlankCcs2LMath.sol paramsHash(), so an on-chain commitment
 *    field can carry the very same bytes32.
 *  - legacy parimutuel rules ("pfss", "stake-only", "stake-multiplier") v1:
 *    paramsHash = "sha256:" + sha256(canonicalJson({schema, rule, version,
 *    params})) — they predate the on-chain hash convention and have no
 *    tunable parameters beyond the rule id itself.
 *
 * ON-CHAIN FIELD: contracts/PlankCrash.sol carries `settlementRuleId` /
 * `settlementParamsHash` as immutables and stamps `paramsHash` into every
 * round commitment (the same transaction that commits the round's drand
 * target); settleRound reverts RuleMismatch unless the executing params hash
 * to the committed value. Off-chain (the playtest laboratory), the same descriptor is
 * persisted in the "round.launched" event payload (lib/playtest-rooms.ts).
 */

import { createHash } from "node:crypto";
import { AbiCoder, keccak256, toUtf8Bytes } from "ethers";
import {
  settleParimutuel,
  type AllocationRule,
  type Seat,
  type Settlement,
} from "./economics";
import {
  DEFAULT_CCS2L_PARAMS,
  settleCcs2L,
  type Ccs2LParams,
  type Ccs2LSettlement,
} from "./economics-ccs2l";

export const SETTLEMENT_REGISTRY_SCHEMA = "plank.settlement-rules.v1";

/** keccak256("ccs-2l") — mirrors PlankCcs2LMath.RULE_ID. */
export const CCS2L_RULE_ID = keccak256(toUtf8Bytes("ccs-2l"));

export interface SettlementRuleDescriptor {
  rule: AllocationRule;
  version: number;
  paramsHash: string;
  /** JSON-safe copy of the parameters the hash commits to. */
  params: Record<string, string>;
}

function canonicalJson(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Byte-identical to contracts/lib/PlankCcs2LMath.sol paramsHash(). */
export function ccs2lParamsHash(params: Ccs2LParams, version = 1): string {
  if (version !== 1) throw new RangeError(`unknown ccs-2l version: ${version}`);
  if (params.playerWeight !== "ln") {
    // Variant A ("ln") is the canonical registered rule. Variant B remains a
    // ratifiable dial but has no registered version yet; committing it would
    // require a new registry entry, never a silent parameter drift.
    throw new RangeError("ccs-2l v1 registers variant A (playerWeight \"ln\") only");
  }
  return keccak256(
    AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "uint256", "uint256", "uint256"],
      [CCS2L_RULE_ID, version, params.floorBps, params.houseCapBps],
    ),
  );
}

export function parimutuelParamsHash(rule: Exclude<AllocationRule, "ccs-2l">, version = 1): string {
  if (version !== 1) throw new RangeError(`unknown ${rule} version: ${version}`);
  return `sha256:${createHash("sha256")
    .update(canonicalJson({ schema: SETTLEMENT_REGISTRY_SCHEMA, rule, version, params: {} }))
    .digest("hex")}`;
}

/** The descriptor to persist at round commitment for a given selection. */
export function settlementDescriptor(
  rule: AllocationRule,
  ccs2lParams: Ccs2LParams = DEFAULT_CCS2L_PARAMS,
): SettlementRuleDescriptor {
  if (rule === "ccs-2l") {
    return {
      rule,
      version: 1,
      paramsHash: ccs2lParamsHash(ccs2lParams),
      params: {
        floorBps: ccs2lParams.floorBps.toString(),
        playerWeight: ccs2lParams.playerWeight,
        houseCapBps: ccs2lParams.houseCapBps.toString(),
      },
    };
  }
  return { rule, version: 1, paramsHash: parimutuelParamsHash(rule), params: {} };
}

export interface CommittedParimutuelRound {
  descriptor: SettlementRuleDescriptor;
  inputs: {
    distributable: bigint;
    crashBps: bigint;
    seats: readonly Seat[];
  };
}

export interface CommittedCcs2LRound {
  descriptor: SettlementRuleDescriptor;
  inputs: {
    playerDistributable: bigint;
    seedH: bigint;
    crashBps: bigint;
    seats: readonly Seat[];
    reserveAtLock: bigint;
  };
}

export type CommittedRound = CommittedParimutuelRound | CommittedCcs2LRound;

export class SettlementRuleMismatch extends Error {}

function reviveCcs2lParams(params: Record<string, string>): Ccs2LParams {
  if (params.playerWeight !== "ln" && params.playerWeight !== "odds") {
    throw new SettlementRuleMismatch(`unknown ccs-2l playerWeight: ${params.playerWeight}`);
  }
  return {
    floorBps: BigInt(params.floorBps),
    playerWeight: params.playerWeight,
    houseCapBps: BigInt(params.houseCapBps),
  };
}

/**
 * Replay a round under its RECORDED rule/version/params — never the current
 * config. Verifies the recorded paramsHash against the recorded params before
 * settling; a mismatch (tampered or drifted record) throws, it never falls
 * back to a default.
 */
export function replayCommittedRound(record: CommittedRound): Settlement | Ccs2LSettlement {
  const { descriptor } = record;
  if (descriptor.version !== 1) {
    throw new SettlementRuleMismatch(`unregistered ${descriptor.rule} version ${descriptor.version}`);
  }
  if (descriptor.rule === "ccs-2l") {
    const params = reviveCcs2lParams(descriptor.params);
    const expected = ccs2lParamsHash(params, descriptor.version);
    if (expected !== descriptor.paramsHash) {
      throw new SettlementRuleMismatch(`ccs-2l params hash mismatch: ${descriptor.paramsHash} != ${expected}`);
    }
    const inputs = (record as CommittedCcs2LRound).inputs;
    return settleCcs2L(
      inputs.playerDistributable,
      inputs.seedH,
      inputs.crashBps,
      inputs.seats,
      inputs.reserveAtLock,
      params,
    );
  }
  const expected = parimutuelParamsHash(descriptor.rule, descriptor.version);
  if (expected !== descriptor.paramsHash) {
    throw new SettlementRuleMismatch(`${descriptor.rule} params hash mismatch`);
  }
  const inputs = (record as CommittedParimutuelRound).inputs;
  return settleParimutuel(descriptor.rule, inputs.distributable, inputs.crashBps, inputs.seats);
}
