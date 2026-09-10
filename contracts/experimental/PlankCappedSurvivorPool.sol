// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Research candidate: pure arithmetic only. Holds no funds and is not
/// wired into PlankCrash. Available budget must already exclude protected funds,
/// fees, refunds and other liabilities in the integrating contract.
contract PlankCappedSurvivorPool {
    uint256 private constant BPS = 10_000;
    struct Seat { uint256 stake; uint256 targetBps; }
    struct Result { uint256[] payouts; uint256 paid; uint256 returned; }
    error InvalidInput();
    error FloorNotFunded();

    /// @dev Floors first, then stake-proportional capped water filling. A capped
    /// survivor's unused allocation is redistributed until all affordable X
    /// claims are paid. Division dust stays in the funding pool, never awarded
    /// as an identity-dependent prize. Worst-case work is bounded by 256^2.
    function settle(uint256 budget, uint256 crashBps, uint256 floorBps, Seat[] calldata seats)
        external pure returns (Result memory r)
    {
        uint256 n = seats.length;
        if (n > 256 || budget > 1e33 || crashBps < BPS || crashBps > 1e8 || floorBps > BPS) revert InvalidInput();
        r.payouts = new uint256[](n);
        uint256[] memory caps = new uint256[](n);
        bool[] memory active = new bool[](n);
        uint256 floors;
        uint256 claims;
        uint256 weight;
        uint256 totalStake;
        for (uint256 i; i < n; ++i) {
            Seat calldata s = seats[i];
            if (s.stake == 0 || s.stake > 1e30 || s.targetBps < 10_100 || s.targetBps > 1e8) revert InvalidInput();
            totalStake += s.stake;
            if (s.targetBps > crashBps) continue;
            active[i] = true;
            weight += s.stake;
            caps[i] = s.stake * s.targetBps / BPS;
            r.payouts[i] = s.stake * floorBps / BPS;
            floors += r.payouts[i];
            claims += caps[i];
        }
        if (totalStake > 1e33) revert InvalidInput();
        if (budget < floors) revert FloorNotFunded();
        if (budget >= claims) {
            r.payouts = caps;
            r.paid = claims;
            r.returned = budget - claims;
            return r;
        }
        uint256 remaining = budget - floors;
        while (weight != 0) {
            bool capped;
            for (uint256 i; i < n; ++i) {
                if (!active[i]) continue;
                uint256 room = caps[i] - r.payouts[i];
                // Bounds: room <= 1e34 and weight <= 1e33, product < 2^256.
                if (room * weight <= remaining * seats[i].stake) {
                    r.payouts[i] = caps[i];
                    remaining -= room;
                    weight -= seats[i].stake;
                    active[i] = false;
                    capped = true;
                }
            }
            if (!capped) {
                for (uint256 i; i < n; ++i) {
                    if (active[i]) r.payouts[i] += remaining * seats[i].stake / weight;
                }
                break;
            }
        }
        for (uint256 i; i < n; ++i) r.paid += r.payouts[i];
        r.returned = budget - r.paid;
    }
}
