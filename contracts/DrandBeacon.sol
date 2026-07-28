// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IDrandBeacon} from "./IDrandBeacon.sol";
import {BLSBN254} from "./lib/BLSBN254.sol";

/**
 * ============================================================================
 *  DrandBeacon — a permissionless, verify-on-chain cache of drand rounds.
 *
 *  WHAT PROBLEM THIS SOLVES
 *  ------------------------
 *  MarketplankVault's random redemption previously seeded from
 *  blockhash(commitBlock). On this chain (Arbitrum Orbit, chainId 4663) that
 *  is sequencer-controlled: Arbitrum's own docs say L2 block hashes are not
 *  cryptographically secure and can be derived in advance by the sequencer.
 *  No contract-side trick fixes that, because the input itself is chosen by a
 *  single party. The only real fix is randomness produced OFF this chain by a
 *  party that cannot see or influence the vault's state, and verified here.
 *
 *  drand (League of Entropy) is exactly that: a threshold BLS network that
 *  publishes a signature per round on a fixed schedule. Its EVM-oriented
 *  beacon signs on BN254 with the signature in G1, so a stock ecPairing call
 *  verifies it. The network is external and pre-existing; nothing needs to be
 *  deployed on this chain except this contract, and nobody needs permission to
 *  relay a round.
 *
 *  TRUST MODEL, STATED PLAINLY
 *  ---------------------------
 *  This replaces "trust the single sequencer" with "trust that a threshold of
 *  the drand League of Entropy committee is not colluding WITH the vault's
 *  adversary". That is a strictly better assumption — a many-party,
 *  publicly-audited, externally-operated threshold network versus one
 *  operator who also orders your transactions — but it is not "no trust". It
 *  is also unbiasable in the direction that matters here: drand rounds are
 *  produced on a wall-clock schedule with no knowledge of this vault, and the
 *  round a request targets is fixed before that round exists.
 *
 *  DEPLOY-TIME PARAMETERS — THE DEPLOYER MUST FILL THESE IN
 *  --------------------------------------------------------
 *  Every drand parameter is a constructor argument. NOTHING is hardcoded,
 *  because the author of this contract had no network access and refuses to
 *  ship an unverified public key. Before deploying, fetch
 *
 *      https://api.drand.sh/<chainHash>/info
 *
 *  and cross-check the SAME response against at least two independent mirrors
 *  (e.g. https://api2.drand.sh/, https://api3.drand.sh/,
 *  https://drand.cloudflare.com/) — the chain hash is the hash of the group
 *  parameters, so a matching `hash` field across independent operators is what
 *  makes the public key trustworthy. Then supply:
 *
 *    chainHash_   the beacon's chain hash (the `hash` field). For drand's
 *                 BN254 EVM beacon ("evmnet") this is expected to be
 *                 0x04f1e9062b8a81f848fded9c12306733282b2727ecced50032187751166ec8c3
 *                 — VERIFY, do not trust this comment.
 *    publicKey_   the group public key, a G2 point, as
 *                 [x_imag, x_real, y_imag, y_real] (EIP-197 ordering — note
 *                 drand's hex encoding is x_real||x_imag||y_real||y_imag in
 *                 some tools; get the ordering right or every verification
 *                 fails, which at least fails closed).
 *    genesis_     the `genesis_time` field (unix seconds).
 *    period_      the `period` field (3 seconds for evmnet).
 *    domain_      the DST used by the beacon's scheme. For the BN254 scheme
 *                 this is expected to be the ASCII string
 *                 "BLS_SIG_BN254G1_XMD:KECCAK-256_SVDW_RO_NUL_" — again,
 *                 VERIFY against the drand source for the `scheme_id` the
 *                 info endpoint reports.
 *
 *  NOTE ON SCHEME NAMING: the drand beacon that is verifiable with the bn128
 *  precompiles is the BN254 one (scheme id "bls-bn254-unchained-on-g1").
 *  "bls-unchained-g1-rfc9380" is quicknet, which is BLS12-381 and needs
 *  EIP-2537 precompiles that are UNCONFIRMED on this chain. Confirm the
 *  scheme_id on the info endpoint matches a BN254 scheme before deploying.
 *
 *  Both beacons are UNCHAINED: the message for a round depends only on the
 *  round number, never on the previous signature. That is what we want — no
 *  chain-of-signatures dependency, so any single round can be relayed
 *  independently and out of order.
 * ============================================================================
 */
contract DrandBeacon is IDrandBeacon {
    /**
     * @dev Group public key (G2), [x_imag, x_real, y_imag, y_real], and the
     * hash-to-curve DST. Both are written once in the constructor and have no
     * setter, so they are `immutable` rather than storage: every submitRound
     * call reads all four key words plus the DST, and paying five-plus cold
     * SLOADs (2100 gas each) for values that can never change is pure waste on
     * the most frequently called function in the system. `bytes` cannot be
     * immutable, so the DST is held as fixed-size words plus a length and
     * reassembled on demand — see _domain(). getPublicKey()/domain() below
     * still return exactly what they always did.
     */
    uint256 private immutable pk0;
    uint256 private immutable pk1;
    uint256 private immutable pk2;
    uint256 private immutable pk3;
    bytes32 private immutable domain0;
    bytes32 private immutable domain1;
    bytes32 private immutable domain2;
    bytes32 private immutable domain3;
    uint256 private immutable domainLength;

    /// @dev Ceiling implied by the four DST words above. drand's BN254 DST is
    /// 43 bytes, so this is ~3x headroom; a longer one would be a different
    /// scheme entirely and must fail closed rather than be silently truncated.
    uint256 private constant MAX_DOMAIN_LENGTH = 128;

    /// @notice The beacon's chain hash. Recorded so a consumer/indexer can
    /// prove which drand chain this contract was configured for.
    bytes32 public immutable chainHash;
    uint256 public immutable override genesisTimestamp;
    uint256 public immutable override period;

    /// @dev round => keccak256(signature). Zero means "not relayed".
    mapping(uint64 => bytes32) private _randomness;

    event RoundSubmitted(uint64 indexed round, bytes32 randomness, address relayer);

    error InvalidPublicKey();
    error InvalidPeriod();
    error InvalidDomain();
    error InvalidRound();
    error InvalidSignaturePoint();
    error InvalidSignature();
    error PairingCallFailed();
    error RoundAlreadySubmitted();
    error RoundNotAvailable();
    error BeforeGenesis();

    constructor(
        bytes32 chainHash_,
        uint256[4] memory publicKey_,
        uint256 genesis_,
        uint256 period_,
        bytes memory domain_
    ) {
        // Fail closed on a garbage public key rather than deploy something
        // that can never verify anything (or, worse, verifies a forgery).
        if (!BLSBN254.isOnCurveG2(publicKey_)) revert InvalidPublicKey();
        if (period_ == 0) revert InvalidPeriod();
        if (domain_.length == 0 || domain_.length > MAX_DOMAIN_LENGTH) revert InvalidDomain();
        chainHash = chainHash_;
        pk0 = publicKey_[0];
        pk1 = publicKey_[1];
        pk2 = publicKey_[2];
        pk3 = publicKey_[3];
        genesisTimestamp = genesis_;
        period = period_;

        // Copy the DST into a zeroed 128-byte buffer first, so the words below
        // can never pick up whatever happened to sit past the string's end in
        // memory. Constructor-only cost; the read path pays nothing for it.
        bytes memory buf = new bytes(MAX_DOMAIN_LENGTH);
        for (uint256 i = 0; i < domain_.length; i++) {
            buf[i] = domain_[i];
        }
        bytes32 d0;
        bytes32 d1;
        bytes32 d2;
        bytes32 d3;
        assembly {
            d0 := mload(add(buf, 32))
            d1 := mload(add(buf, 64))
            d2 := mload(add(buf, 96))
            d3 := mload(add(buf, 128))
        }
        domain0 = d0;
        domain1 = d1;
        domain2 = d2;
        domain3 = d3;
        domainLength = domain_.length;
    }

    /// @dev Reassemble the DST from its immutable words. Only whole words that
    /// the length actually covers are written, so this stays inside what
    /// `new bytes(len)` allocated; trailing bytes in the final word are zero in
    /// both the source buffer and a fresh allocation, so the result is byte-
    /// identical to the constructor argument.
    function _domain() private view returns (bytes memory out) {
        uint256 len = domainLength;
        out = new bytes(len);
        uint256 words = (len + 31) / 32;
        bytes32 d0 = domain0;
        bytes32 d1 = domain1;
        bytes32 d2 = domain2;
        bytes32 d3 = domain3;
        assembly {
            mstore(add(out, 32), d0)
            if gt(words, 1) {
                mstore(add(out, 64), d1)
            }
            if gt(words, 2) {
                mstore(add(out, 96), d2)
            }
            if gt(words, 3) {
                mstore(add(out, 128), d3)
            }
        }
    }

    /// @notice The hash-to-curve DST. Set once at construction, no setter.
    function domain() public view returns (bytes memory) {
        return _domain();
    }

    // ── Relay ──────────────────────────────────────────────────────────────

    /**
     * @notice Relay a published drand round. Permissionless: anyone at all —
     * a cron job, a bot, the vault owner, a passer-by — may call this, and the
     * caller gets no privilege from doing so. The signature is verified here;
     * an invalid one reverts and NOTHING is written.
     *
     * @param round the drand round number.
     * @param signature the round's BLS signature, a G1 point [x, y].
     *
     * Replay/overwrite policy: BLS signatures are deterministic, so for a
     * given group key and round there is exactly ONE valid signature. The
     * first valid submission therefore already fixes the only possible value.
     * A later submission of the identical signature is accepted as a harmless
     * no-op (so honest racing relayers don't eat a revert and waste gas on a
     * confusing error); a later submission of anything DIFFERENT is rejected,
     * because it is by construction either a forgery or a different round.
     * Values are never overwritten, so there is no griefing lever here.
     */
    function submitRound(uint64 round, uint256[2] calldata signature) external {
        if (round == 0) revert InvalidRound();

        bytes32 randomness = keccak256(abi.encodePacked(signature[0], signature[1]));
        bytes32 existing = _randomness[round];
        if (existing != bytes32(0)) {
            // Identical to what was already verified — idempotent no-op.
            if (existing == randomness) return;
            revert RoundAlreadySubmitted();
        }

        uint256[2] memory sig = [signature[0], signature[1]];
        if (!BLSBN254.isValidSignature(sig)) revert InvalidSignaturePoint();

        uint256[2] memory message = messagePoint(round);
        (bool valid, bool callOk) = BLSBN254.verifySingle(sig, _publicKey(), message);
        // A precompile that did not run is NOT a verification failure; treat
        // it as its own hard error so it can never be mistaken for "invalid".
        if (!callOk) revert PairingCallFailed();
        if (!valid) revert InvalidSignature();

        _randomness[round] = randomness;
        emit RoundSubmitted(round, randomness, msg.sender);
    }

    // ── Views ──────────────────────────────────────────────────────────────

    /**
     * @notice The G1 point a round's signature is taken over.
     * @dev drand's unchained schemes sign H(round). The preimage is the round
     * number as an 8-byte big-endian integer, hashed with keccak256, and that
     * 32-byte digest is what gets mapped to the curve. This must match drand's
     * wire format exactly — see the interop note at the top of BLSBN254.sol.
     */
    function messagePoint(uint64 round) public view returns (uint256[2] memory) {
        bytes memory preimage = abi.encodePacked(keccak256(abi.encodePacked(round)));
        return BLSBN254.hashToPoint(_domain(), preimage);
    }

    function isRoundAvailable(uint64 round) external view override returns (bool) {
        return _randomness[round] != bytes32(0);
    }

    function randomnessAt(uint64 round) external view override returns (bytes32) {
        bytes32 r = _randomness[round];
        if (r == bytes32(0)) revert RoundNotAvailable();
        return r;
    }

    /**
     * @notice The verified randomness for `round`, or zero if it has not been
     * relayed yet.
     * @dev Exists so a consumer can answer "is it there, and what is it?" in
     * ONE external call instead of isRoundAvailable() followed by
     * randomnessAt(). A verified round can never hash to zero in practice, and
     * a caller must treat zero as "not available" — which is exactly the guard
     * MarketplankVault._pinPendingDraw already had.
     */
    function randomnessOrZero(uint64 round) external view override returns (bytes32) {
        return _randomness[round];
    }

    /**
     * @dev drand's real convention: round 1 is published AT genesis_time, so
     * TimeOfRound(r) = genesis + (r-1)*period and therefore
     * round_at(t) = floor((t - genesis)/period) + 1.
     *
     * This previously omitted the +1, which made every round number reported
     * here exactly one less than drand's own. Nothing verified was affected —
     * submitRound hashes the round number the relayer supplies — but every
     * consumer that anchors a future round from a timestamp silently lost one
     * period of lead: MarketplankVault's requests were targeting a round only
     * ~3s ahead instead of the ~6s its comments promise, so a chain clock
     * lagging real wall time by a single period could have seen the target
     * round published before the request transaction even landed.
     */
    function currentRoundAt(uint256 timestamp) public view override returns (uint64) {
        if (timestamp < genesisTimestamp) return 0;
        return uint64((timestamp - genesisTimestamp) / period) + 1;
    }

    function nextRoundAfter(uint256 timestamp) external view override returns (uint64) {
        if (timestamp < genesisTimestamp) revert BeforeGenesis();
        return currentRoundAt(timestamp) + 1;
    }

    function _publicKey() private view returns (uint256[4] memory) {
        return [pk0, pk1, pk2, pk3];
    }

    /// @notice Group public key (G2), [x_imag, x_real, y_imag, y_real].
    function publicKey(uint256 i) external view returns (uint256) {
        if (i == 0) return pk0;
        if (i == 1) return pk1;
        if (i == 2) return pk2;
        if (i == 3) return pk3;
        revert InvalidPublicKey();
    }

    function getPublicKey() external view returns (uint256[4] memory) {
        return _publicKey();
    }
}
