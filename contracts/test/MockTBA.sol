// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

/**
 * @notice Test-only ERC-6551 token-bound account, following the reference
 * account's shape: `token()` / `owner()` views plus `execute(to,value,data,op)`
 * gated on the owner. Never deployed anywhere real; exists solely for
 * TBAValueSweeper.test.ts.
 *
 * The owner gate is the real one: ownership resolves through the bound NFT's
 * `ownerOf`, so while the vault holds the NFT the vault is the owner — which
 * is exactly the property the sweeper relies on, and exactly the property that
 * makes a general-purpose calldata forwarder dangerous.
 */
contract MockTBA is IERC721Receiver {
    uint256 public immutable boundChainId;
    address public immutable boundCollection;
    uint256 public immutable boundTokenId;

    /// @notice When set, `owner()` returns this instead of the real ownerOf —
    /// used to exercise the sweeper's owner-mismatch branch.
    address public ownerOverride;

    constructor(uint256 chainId_, address collection_, uint256 tokenId_) {
        boundChainId = chainId_;
        boundCollection = collection_;
        boundTokenId = tokenId_;
    }

    function token() external view returns (uint256, address, uint256) {
        return (boundChainId, boundCollection, boundTokenId);
    }

    function owner() public view returns (address) {
        if (ownerOverride != address(0)) return ownerOverride;
        if (boundChainId != block.chainid) return address(0);
        return ERC721(boundCollection).ownerOf(boundTokenId);
    }

    function setOwnerOverride(address who) external {
        ownerOverride = who;
    }

    /**
     * @dev The real ERC-6551 execute: arbitrary calldata as this account,
     * gated on the resolved owner. The sweeper is the caller in tests, so the
     * gate is relaxed to "owner, or a caller the owner authorised" — modelled
     * here as an explicit operator set, because in production the sweeper
     * would be reached the same way.
     */
    mapping(address => bool) public operators;

    function setOperator(address who, bool ok) external {
        operators[who] = ok;
    }

    error NotAuthorized();
    error OnlyCall();

    function execute(address to, uint256 value, bytes calldata data, uint8 operation)
        external
        payable
        returns (bytes memory)
    {
        if (operation != 0) revert OnlyCall();
        if (msg.sender != owner() && !operators[msg.sender]) revert NotAuthorized();
        (bool ok, bytes memory ret) = to.call{value: value}(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
        return ret;
    }

    function onERC721Received(address, address, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return IERC721Receiver.onERC721Received.selector;
    }

    receive() external payable {}
}

/// @notice A TBA whose `token()` names a token id / collection / chain of the
/// deployer's choosing — used to prove an unbound TBA cannot be swept from.
contract MockTBALiar is MockTBA {
    constructor(uint256 chainId_, address collection_, uint256 tokenId_)
        MockTBA(chainId_, collection_, tokenId_)
    {}
}

/// @notice ERC-20 that reports a balance but moves nothing on `transfer`,
/// while still returning true. The `SweepDidNotLand` case.
contract MockLyingERC20 is ERC20 {
    constructor() ERC20("Lying", "LIE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function transfer(address, uint256) public pure override returns (bool) {
        return true;
    }
}

/**
 * @notice ERC-20 that re-enters the sweeper on every transfer. Proves the
 * `nonReentrant` guard and, more importantly, that a re-entrant sweep cannot
 * double-credit: the second pass finds a zero TBA balance.
 */
contract MockReentrantSweepERC20 is ERC20 {
    address public sweeper;
    bytes public payload;
    bool public armed;
    bool public reentered;
    bytes public lastRevert;

    constructor() ERC20("Reentrant", "RE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(address sweeper_, bytes calldata payload_) external {
        sweeper = sweeper_;
        payload = payload_;
        armed = true;
    }

    function _afterTokenTransfer(address, address, uint256) internal override {
        if (!armed || reentered) return;
        reentered = true;
        (bool ok, bytes memory ret) = sweeper.call(payload);
        if (!ok) lastRevert = ret;
    }
}

/// @notice ERC-721 whose `onERC721Received` always reverts when it is the
/// RECEIVER, used as a hostile miscellany sink.
contract MockRevertingReceiver is IERC721Receiver {
    error Nope();

    function onERC721Received(address, address, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert Nope();
    }
}

/// @notice Plain ERC-721 holder, the well-behaved miscellany sink.
contract MockMiscellanySink is IERC721Receiver {
    function onERC721Received(address, address, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return IERC721Receiver.onERC721Received.selector;
    }
}

/// @notice Mintable ERC-721 used for airdropped sub-NFTs and for LP positions.
contract MockSubNft is ERC721 {
    constructor(string memory n, string memory s) ERC721(n, s) {}

    function mint(address to, uint256 tokenId) external {
        _mint(to, tokenId);
    }
}

/**
 * @notice Uniswap-v3-style position manager: an ERC-721 of positions, each
 * with uncollected fees in two ERC-20s that only `collect` can move, and only
 * to the recipient the caller names. That last part is the reason the sweeper
 * hardcodes the recipient.
 */
contract MockPositionManager is ERC721 {
    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    IERC20 public immutable token0;
    IERC20 public immutable token1;

    mapping(uint256 => uint256) public owed0;
    mapping(uint256 => uint256) public owed1;

    error NotOwner();

    constructor(IERC20 t0, IERC20 t1) ERC721("Mock Positions", "mPOS") {
        token0 = t0;
        token1 = t1;
    }

    function mintPosition(address to, uint256 tokenId, uint256 fees0, uint256 fees1) external {
        _mint(to, tokenId);
        owed0[tokenId] = fees0;
        owed1[tokenId] = fees1;
    }

    function collect(CollectParams calldata p) external returns (uint256 a0, uint256 a1) {
        if (ownerOf(p.tokenId) != msg.sender) revert NotOwner();
        a0 = owed0[p.tokenId] < p.amount0Max ? owed0[p.tokenId] : p.amount0Max;
        a1 = owed1[p.tokenId] < p.amount1Max ? owed1[p.tokenId] : p.amount1Max;
        owed0[p.tokenId] -= a0;
        owed1[p.tokenId] -= a1;
        if (a0 > 0) token0.transfer(p.recipient, a0);
        if (a1 > 0) token1.transfer(p.recipient, a1);
    }
}
