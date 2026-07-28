// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BLSBN254} from "../lib/BLSBN254.sol";

/// TEST ONLY. Exposes the internals of the BLS library so the hash-to-curve
/// pipeline can be compared step by step against an independent JS
/// implementation, rather than only being checked end to end.
contract BLSHarness {
    function expandMsgTo96(bytes calldata domain, bytes calldata message)
        external
        pure
        returns (bytes memory)
    {
        return BLSBN254.expandMsgTo96(domain, message);
    }

    function hashToField(bytes calldata domain, bytes calldata message)
        external
        pure
        returns (uint256[2] memory)
    {
        return BLSBN254.hashToField(domain, message);
    }

    function mapToPoint(uint256 u) external view returns (uint256[2] memory) {
        return BLSBN254.mapToPoint(u);
    }

    function hashToPoint(bytes calldata domain, bytes calldata message)
        external
        view
        returns (uint256[2] memory)
    {
        return BLSBN254.hashToPoint(domain, message);
    }

    function isOnCurveG1(uint256[2] calldata p) external pure returns (bool) {
        return BLSBN254.isOnCurveG1(p);
    }

    function isOnCurveG2(uint256[4] calldata p) external pure returns (bool) {
        return BLSBN254.isOnCurveG2(p);
    }

    function verifySingle(
        uint256[2] calldata signature,
        uint256[4] calldata pubkey,
        uint256[2] calldata message
    ) external view returns (bool, bool) {
        return BLSBN254.verifySingle(signature, pubkey, message);
    }

    function constants()
        external
        pure
        returns (uint256 p, uint256 c1, uint256 c2, uint256 c3, uint256 c4, uint256 zPad)
    {
        return (
            BLSBN254.P,
            BLSBN254.SVDW_C1,
            BLSBN254.SVDW_C2,
            BLSBN254.SVDW_C3,
            BLSBN254.SVDW_C4,
            BLSBN254.Z_PAD_LEN
        );
    }
}
