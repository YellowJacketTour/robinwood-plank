// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Capped survivor sharing. The caller escrows D + H before settlement.
/// Protected principal, fees, refunds and other rounds are never funding inputs.
library PlankCappedPoolMath {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant MIN_TARGET_BPS = 10_100;
    uint256 internal constant MAX_STAKE = 1e30;
    uint256 internal constant MAX_POT = 1e33;
    bytes32 internal constant RULE_ID = keccak256("capped-survivor-pool");
    uint256 internal constant RULE_VERSION = 1;
    struct Seat { uint256 stake; uint256 targetBps; }
    // Legacy configuration slots remain ABI compatible, but only floorBps and
    // houseCapBps govern this rule. All slots are committed to prevent ambiguity.
    struct Params {
        uint256 floorBps; uint256 houseCapBps; uint256 houseRakeCapBps;
        uint256 maxVaultBonusBps; uint256 vaultBonusDecayWad;
    }
    struct Result {
        uint8 mode; uint256 lambda; uint256 totalPlayerPaid; uint256 totalBonus;
        uint256 houseReturned; uint256 bustedToReserve; uint256 playerDust;
        int256 dustIndex; uint256[] playerPayouts; uint256[] bonuses;
    }
    error InvalidInput();
    error FloorNotFunded();
    function paramsHash(Params memory p) internal pure returns(bytes32) {
        return keccak256(abi.encode(RULE_ID, RULE_VERSION, p.floorBps, p.houseCapBps,
            p.houseRakeCapBps, p.maxVaultBonusBps, p.vaultBonusDecayWad));
    }

    function settle(uint256 d, uint256 h, uint256 crash, Seat[] memory seats,
        uint256, uint256, uint256, Params memory params) internal pure returns(Result memory r)
    {
        uint256 n = seats.length;
        if(n > 256 || d > MAX_POT || h > MAX_POT || crash < BPS || crash > 1e8 || params.floorBps > BPS) revert InvalidInput();
        uint256[] memory payouts = new uint256[](n);
        uint256[] memory caps = new uint256[](n);
        bool[] memory active = new bool[](n);
        uint256 floors; uint256 claims; uint256 weight; uint256 totalStake;
        for(uint256 i; i < n; ++i) {
            Seat memory s = seats[i];
            if(s.stake == 0 || s.stake > MAX_STAKE || s.targetBps < MIN_TARGET_BPS || s.targetBps > 1e8) revert InvalidInput();
            totalStake += s.stake;
            if(s.targetBps > crash) continue;
            active[i] = true; weight += s.stake;
            caps[i] = s.stake * s.targetBps / BPS;
            payouts[i] = s.stake * params.floorBps / BPS;
            floors += payouts[i]; claims += caps[i];
        }
        if(totalStake > MAX_POT) revert InvalidInput();
        uint256 budget = d + h;
        if(budget < floors) revert FloorNotFunded();
        r.mode = weight == 0 ? 0 : 2;
        if(budget >= claims) payouts = caps;
        else {
            uint256 remaining = budget - floors;
            while(weight != 0) {
                bool capped;
                for(uint256 i; i < n; ++i) {
                    if(!active[i]) continue;
                    uint256 room = caps[i] - payouts[i];
                    // At configured bounds both products are < 2^256.
                    if(room * weight <= remaining * seats[i].stake) {
                        payouts[i] = caps[i]; remaining -= room;
                        weight -= seats[i].stake; active[i] = false; capped = true;
                    }
                }
                if(!capped) {
                    r.lambda = remaining * 1e18 / weight;
                    for(uint256 i; i < n; ++i) if(active[i]) payouts[i] += remaining * seats[i].stake / weight;
                    break;
                }
            }
        }
        r.playerPayouts = new uint256[](n); r.bonuses = new uint256[](n);
        r.dustIndex = -1;
        // Source attribution only: spend the player purse first. Position
        // ordering can change attribution, never the position's total payout.
        uint256 playerRemaining = d;
        for(uint256 i; i < n; ++i) {
            uint256 playerPart = payouts[i] < playerRemaining ? payouts[i] : playerRemaining;
            r.playerPayouts[i] = playerPart; playerRemaining -= playerPart;
            r.bonuses[i] = payouts[i] - playerPart;
            r.totalPlayerPaid += playerPart; r.totalBonus += r.bonuses[i];
        }
        r.houseReturned = h - r.totalBonus;
        // In this rule this field is ALL unused player funding, including
        // capped-survivor surplus and division dust, not just busted rounds.
        r.bustedToReserve = playerRemaining;
    }
}
