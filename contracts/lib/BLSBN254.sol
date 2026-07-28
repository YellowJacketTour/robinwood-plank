// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * ============================================================================
 *  BLSBN254 — BLS signature verification on the alt_bn128 (BN254) curve, using
 *  ONLY the precompiles every EVM chain ships: 0x05 (modexp), 0x06 (ecAdd),
 *  0x08 (ecPairing). Confirmed present and working on Robinhood Chain
 *  (Arbitrum Orbit, chainId 4663) by direct eth_call probing.
 *
 *  WHY THIS EXISTS
 *  ---------------
 *  This is the verification half of a drand beacon reader. drand (League of
 *  Entropy) publishes threshold BLS signatures on a fixed schedule; its
 *  EVM-oriented beacon signs on BN254 with the signature in G1 and the group
 *  public key in G2, precisely so that a contract can check it with the stock
 *  bn128 pairing precompile. Nothing about drand needs to be deployed on this
 *  chain: the threshold network is entirely external, and anyone at all can
 *  relay a published round's signature here.
 *
 *  PROVENANCE / WHAT THIS IS BASED ON
 *  ----------------------------------
 *  The scheme and the on-chain shape follow the well-known lineage:
 *    - RFC 9380 (Hashing to Elliptic Curves) §6.6.1 "Shallue-van de Woestijne"
 *      and §5.3.1 expand_message_xmd — the mapping used below is a direct,
 *      step-numbered transcription of RFC 9380 Appendix F.1's straight-line
 *      SvdW implementation, specialised to A = 0, B = 3, Z = 1.
 *    - hubble-contracts' BLS.sol and kevincharm/bls-bn254 (and the Anyrand
 *      protocol built on it) established this exact pattern: keccak256 as the
 *      expand_message_xmd hash, SvdW map, G1 signature / G2 public key, single
 *      ecPairing call.
 *  This file is written from the RFC rather than vendored, so every step is
 *  auditable here and the constants below are derived (and re-derived in the
 *  tests) rather than copied on faith.
 *
 *  !!! INTEROPERABILITY RISK — READ BEFORE MAINNET DEPLOY !!!
 *  ----------------------------------------------------------
 *  Two things must byte-for-byte match the real drand beacon, and NEITHER
 *  could be confirmed against the live network from the sandbox this was
 *  written in (no network access):
 *
 *    (1) Z_PAD_LEN below. RFC 9380 fixes expand_message_xmd's leading zero pad
 *        at s_in_bytes = the hash function's INPUT BLOCK SIZE. For Keccak-256
 *        that is 136 bytes (the sponge rate), which is what Go's
 *        golang.org/x/crypto/sha3 reports as BlockSize(), and drand is Go. So
 *        136 is the RFC-correct and almost certainly the drand-correct value.
 *        Some older Solidity ports hardcode 64 (the SHA-256 block size) even
 *        while hashing with keccak256; such a port is NOT RFC-compliant and
 *        will not verify real drand rounds.
 *    (2) DOMAIN (the DST) and the exact preimage bytes of the round message.
 *        Both are passed in by the caller (see DrandBeacon.sol) so they are
 *        deploy-time parameters, not baked in here.
 *
 *  test/contracts/DrandBeacon.realsig.test.ts contains an OPTIONAL fixture
 *  test: drop a real (round, signature) pair fetched from
 *  https://api.drand.sh/<chainHash>/public/<round> into
 *  test/contracts/fixtures/drand-round.json and it will prove end-to-end
 *  interoperability against the genuine beacon. Until that fixture passes, the
 *  verifier is proven self-consistent and cryptographically sound, but NOT
 *  proven wire-compatible with drand. Do not deploy with real value before
 *  running it.
 * ============================================================================
 */
library BLSBN254 {
    /// @dev BN254 base field modulus (a.k.a. `p` / `N` in other ports).
    uint256 internal constant P =
        21888242871839275222246405745257275088696311157297823662689037894645226208583;

    /// @dev Curve is y^2 = x^3 + 3 over Fp. A = 0, so it never appears below.
    uint256 internal constant CURVE_B = 3;

    // --- RFC 9380 Appendix F.1 SvdW constants, for A = 0, B = 3, Z = 1 ------
    // g(Z) = Z^3 + 3 = 4
    //   c1 = g(Z)                              = 4
    //   c2 = -Z / 2                            = (P - 1) / 2
    //   c3 = sqrt(-g(Z) * (3 * Z^2 + 4A))      = sqrt(-12), with sgn0(c3) == 0
    //   c4 = -4 * g(Z) / (3 * Z^2 + 4A)        = -16 / 3
    // Each is re-derived independently in the tests; they are not magic.
    uint256 internal constant SVDW_C1 = 4;
    uint256 internal constant SVDW_C2 =
        10944121435919637611123202872628637544348155578648911831344518947322613104291;
    uint256 internal constant SVDW_C3 = 8815841940592487685674414971303048083897117035520822607866;
    uint256 internal constant SVDW_C4 =
        7296080957279758407415468581752425029565437052432607887563012631548408736189;

    // --- The NEGATED G2 generator -------------------------------------------
    // Fp2 elements are ordered (imaginary, real) on the wire, per EIP-197.
    // Using -G2 lets the whole check be one product-of-pairings == 1 call:
    //     e(sig, -G2) * e(H(m), pk) == 1   <=>   e(sig, G2) == e(H(m), pk)
    uint256 internal constant NEG_G2_X1 =
        11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 internal constant NEG_G2_X0 =
        10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 internal constant NEG_G2_Y1 =
        17805874995975841540914202342111839520379459829704422454583296818431106115052;
    uint256 internal constant NEG_G2_Y0 =
        13392588948715843804641432497768002650278120570034223513918757245338268106653;

    /// @dev expand_message_xmd's leading zero pad = hash input block size.
    /// Keccak-256's block size (sponge rate) is 136 bytes. See the header note.
    uint256 internal constant Z_PAD_LEN = 136;

    error ExpandTooLong();
    error DomainTooLong();
    error ModexpFailed();
    error PairingFailed();

    /**
     * @notice The BLS check: is `signature` (G1) a valid signature by `pubkey`
     * (G2) over the G1 point `message`?
     * @dev Returns (pairingHolds, callSucceeded). A failed precompile call is
     * reported separately so callers can fail closed rather than read a false
     * "invalid" as an authoritative answer.
     */
    function verifySingle(
        uint256[2] memory signature,
        uint256[4] memory pubkey,
        uint256[2] memory message
    ) internal view returns (bool pairingHolds, bool callSucceeded) {
        uint256[12] memory input = [
            signature[0],
            signature[1],
            NEG_G2_X1,
            NEG_G2_X0,
            NEG_G2_Y1,
            NEG_G2_Y0,
            message[0],
            message[1],
            pubkey[0],
            pubkey[1],
            pubkey[2],
            pubkey[3]
        ];
        uint256[1] memory out;
        bool ok;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            ok := staticcall(gas(), 8, input, 384, out, 32)
        }
        return (out[0] != 0, ok);
    }

    /// @notice Is `point` a valid, non-identity G1 point? (BN254 G1 has
    /// cofactor 1, so on-curve + in-field is exactly "in the prime group".)
    function isValidSignature(uint256[2] memory point) internal pure returns (bool) {
        if (point[0] >= P || point[1] >= P) return false;
        return isOnCurveG1(point);
    }

    function isOnCurveG1(uint256[2] memory point) internal pure returns (bool) {
        uint256 x = point[0];
        uint256 y = point[1];
        if (x >= P || y >= P) return false;
        // Reject the point at infinity (0,0): it verifies against anything for
        // a zero-ish message and is never a legitimate drand signature.
        if (x == 0 && y == 0) return false;
        uint256 lhs = mulmod(y, y, P);
        uint256 rhs = addmod(mulmod(mulmod(x, x, P), x, P), CURVE_B, P);
        return lhs == rhs;
    }

    /// @notice Is `point` (x1, x0, y1, y0 — EIP-197 order) on the G2 curve
    /// y^2 = x^3 + b2 over Fp2?
    function isOnCurveG2(uint256[4] memory point) internal pure returns (bool) {
        for (uint256 i = 0; i < 4; i++) {
            if (point[i] >= P) return false;
        }
        // b2 = 3 / (9 + i)
        uint256 b2r = 19485874751759354771024239261021720505790618469301721065564631296452457478373;
        uint256 b2i = 266929791119991161246907387137283842545076965332900288569378510910307636690;
        (uint256 x1, uint256 x0, uint256 y1, uint256 y0) =
            (point[0], point[1], point[2], point[3]);
        if (x0 == 0 && x1 == 0 && y0 == 0 && y1 == 0) return false;
        (uint256 yy0, uint256 yy1) = _fp2Mul(y0, y1, y0, y1);
        (uint256 xx0, uint256 xx1) = _fp2Mul(x0, x1, x0, x1);
        (uint256 xxx0, uint256 xxx1) = _fp2Mul(xx0, xx1, x0, x1);
        return yy0 == addmod(xxx0, b2r, P) && yy1 == addmod(xxx1, b2i, P);
    }

    function _fp2Mul(uint256 a0, uint256 a1, uint256 b0, uint256 b1)
        private
        pure
        returns (uint256 c0, uint256 c1)
    {
        // (a0 + a1*i)(b0 + b1*i) = (a0b0 - a1b1) + (a0b1 + a1b0)i
        c0 = addmod(mulmod(a0, b0, P), P - mulmod(a1, b1, P), P);
        c1 = addmod(mulmod(a0, b1, P), mulmod(a1, b0, P), P);
    }

    /**
     * @notice RFC 9380 hash_to_curve: map arbitrary bytes to a G1 point.
     * @param domain the DST (domain separation tag), max 255 bytes.
     */
    function hashToPoint(bytes memory domain, bytes memory message)
        internal
        view
        returns (uint256[2] memory)
    {
        uint256[2] memory u = hashToField(domain, message);
        uint256[2] memory p0 = mapToPoint(u[0]);
        uint256[2] memory p1 = mapToPoint(u[1]);
        return _ecAdd(p0, p1);
    }

    /// @dev RFC 9380 §5.2 hash_to_field with count = 2, m = 1, L = 48.
    function hashToField(bytes memory domain, bytes memory message)
        internal
        pure
        returns (uint256[2] memory)
    {
        bytes memory expanded = expandMsgTo96(domain, message);
        uint256[2] memory out;
        for (uint256 i = 0; i < 2; i++) {
            // OS2IP of a 48-byte chunk, reduced mod P. Done as
            // (hi * 2^256 + lo) mod P with hi the top 16 bytes.
            uint256 hi;
            uint256 lo;
            uint256 off = 48 * i;
            // solhint-disable-next-line no-inline-assembly
            assembly {
                let base := add(expanded, 32)
                hi := shr(128, mload(add(base, off)))
                lo := mload(add(base, add(off, 16)))
            }
            // 2^256 mod P
            uint256 twoTo256 =
                6350874878119819312338956282401532409788428879151445726012394534686998597021;
            out[i] = addmod(mulmod(hi, twoTo256, P), lo % P, P);
        }
        return out;
    }

    /**
     * @dev RFC 9380 §5.3.1 expand_message_xmd, hash = keccak256,
     * len_in_bytes = 96 (so ell = 3), b_in_bytes = 32, s_in_bytes = Z_PAD_LEN.
     *
     *   msg_prime = Z_pad || msg || I2OSP(96, 2) || I2OSP(0, 1) || DST_prime
     *   b_0 = H(msg_prime)
     *   b_1 = H(b_0 || I2OSP(1,1) || DST_prime)
     *   b_i = H((b_0 ^ b_{i-1}) || I2OSP(i,1) || DST_prime)
     */
    function expandMsgTo96(bytes memory domain, bytes memory message)
        internal
        pure
        returns (bytes memory)
    {
        if (domain.length > 255) revert DomainTooLong();
        bytes memory dstPrime = abi.encodePacked(domain, uint8(domain.length));

        bytes32 b0 = keccak256(
            abi.encodePacked(new bytes(Z_PAD_LEN), message, uint16(96), uint8(0), dstPrime)
        );
        bytes32 b1 = keccak256(abi.encodePacked(b0, uint8(1), dstPrime));
        bytes32 b2 = keccak256(abi.encodePacked(b0 ^ b1, uint8(2), dstPrime));
        bytes32 b3 = keccak256(abi.encodePacked(b0 ^ b2, uint8(3), dstPrime));
        return abi.encodePacked(b1, b2, b3);
    }

    /**
     * @dev RFC 9380 Appendix F.1 — Shallue-van de Woestijne, straight-line.
     * Step numbers below are the RFC's own. A = 0 so steps 12/30 (adding A)
     * vanish, and Z = 1 so step 26 adds 1.
     */
    function mapToPoint(uint256 u) internal view returns (uint256[2] memory point) {
        u = u % P;
        uint256 x;
        {
            uint256 tv1 = mulmod(mulmod(u, u, P), SVDW_C1, P); //  1,2
            uint256 tv2 = addmod(1, tv1, P); //                     3
            tv1 = addmod(1, P - tv1, P); //                         4
            uint256 tv3 = _inv0(mulmod(tv1, tv2, P)); //            5,6
            uint256 tv4 = mulmod(mulmod(mulmod(u, tv1, P), tv3, P), SVDW_C3, P); // 7,8,9

            uint256 x1 = addmod(SVDW_C2, P - tv4, P); //           10
            bool e1 = _isSquare(_gx(x1)); //                       11-15
            uint256 x2 = addmod(SVDW_C2, tv4, P); //               16
            bool e2 = !e1 && _isSquare(_gx(x2)); //                17-21

            uint256 x3 = mulmod(tv2, tv2, P); //                   22
            x3 = mulmod(x3, tv3, P); //                            23
            x3 = mulmod(x3, x3, P); //                             24
            x3 = mulmod(x3, SVDW_C4, P); //                        25
            x3 = addmod(x3, 1, P); //                              26 (Z = 1)

            x = e1 ? x1 : (e2 ? x2 : x3); //                       27,28
        }
        uint256 y = _sqrt(_gx(x)); //                              29-33
        // 34,35: fix the sign of y to match the sign of u.
        if ((u & 1) != (y & 1)) {
            y = P - y;
        }
        point[0] = x;
        point[1] = y;
    }

    /// @dev g(x) = x^3 + B on this curve (A = 0).
    function _gx(uint256 x) private pure returns (uint256) {
        return addmod(mulmod(mulmod(x, x, P), x, P), CURVE_B, P);
    }

    // --- field helpers, all via the modexp precompile (0x05) ----------------

    /// @dev inv0(x): x^(P-2), with inv0(0) = 0 as RFC 9380 requires.
    function _inv0(uint256 x) private view returns (uint256) {
        if (x == 0) return 0;
        return _expmod(x, P - 2);
    }

    /// @dev P = 3 mod 4, so sqrt(a) = a^((P+1)/4) when a is a QR.
    function _sqrt(uint256 a) private view returns (uint256) {
        return _expmod(a, (P + 1) / 4);
    }

    /// @dev Euler's criterion. 0 counts as a square, matching RFC is_square.
    function _isSquare(uint256 a) private view returns (bool) {
        if (a == 0) return true;
        return _expmod(a, (P - 1) / 2) == 1;
    }

    function _expmod(uint256 base, uint256 exponent) private view returns (uint256 result) {
        bool ok;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            let ptr := mload(0x40)
            mstore(ptr, 0x20)
            mstore(add(ptr, 0x20), 0x20)
            mstore(add(ptr, 0x40), 0x20)
            mstore(add(ptr, 0x60), base)
            mstore(add(ptr, 0x80), exponent)
            mstore(add(ptr, 0xa0), P)
            ok := staticcall(gas(), 5, ptr, 0xc0, ptr, 0x20)
            result := mload(ptr)
        }
        if (!ok) revert ModexpFailed();
    }

    /// @dev G1 point addition via the ecAdd precompile (0x06).
    function _ecAdd(uint256[2] memory a, uint256[2] memory b)
        private
        view
        returns (uint256[2] memory c)
    {
        uint256[4] memory input = [a[0], a[1], b[0], b[1]];
        bool ok;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            ok := staticcall(gas(), 6, input, 128, c, 64)
        }
        if (!ok) revert PairingFailed();
    }
}
