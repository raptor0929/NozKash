// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title GhostVault — Revision D (minimal PoC)
 * @notice Ingress (deposit), delivery (announce), and egress (redeem) for
 *         fixed-denomination eCash with ECDSA nullifier + BLS pairing on BN254.
 *         Refund path: if the mint never fulfils, the original depositor can
 *         reclaim the locked ETH (see `refund`). `depositors[depositId]` links
 *         the blind depositId to the EOA that sent `deposit()` (PoC tradeoff).
 *
 * Key derivation (client-side only — never sent to mint):
 *
 *   base        = keccak256(master_seed ‖ token_index)
 *
 *   spend keypair:
 *     spend_priv = keccak256("spend" ‖ base)   [secp256k1 scalar]
 *     spend_addr = address(spend_priv · G)      [nullifier — revealed only at redeem]
 *
 *   blind keypair:
 *     blind_priv = keccak256("blind" ‖ base)   [secp256k1 scalar → also BN254 scalar r]
 *     blind_addr = address(blind_priv · G)      [depositId — revealed at deposit time]
 *     r          = blind_priv mod BN254_ORDER   [multiplicative blinding factor]
 *
 *   blinded point sent to mint:
 *     B = r · H_G1(spend_addr)
 *
 * Privacy design:
 *   - depositId = blind_addr.  Revealed at deposit but cannot be linked to
 *     spend_addr without the master seed.
 *   - spend_addr never appears on-chain until redeem.
 *   - announce() is restricted to mintAuthority to prevent scan-DoS.
 *   - S' is emitted in plaintext (safe: useless without r).
 *
 * Off-chain scanning after wallet recovery:
 *   - Deposits:  recompute blind_addr_i from seed; query DepositLocked indexed
 *                by depositId = blind_addr_i directly (O(n) RPC calls, no scan).
 *   - Minted:    fetch MintFulfilled for the matched depositId; unblind locally.
 *   - Redeemed:  call spentNullifiers[spend_addr_i] for each known index.
 *
 * Implementation notes:
 *   - depositId is type address (20 bytes) — matches blind_addr naturally.
 *   - r = 0 after mod is astronomically unlikely (p ~2^-254) but must be
 *     rejected client-side before calling deposit().
 *   - blind_priv is a secp256k1 scalar reduced mod BN254_ORDER; the small
 *     statistical bias is negligible for this use case but is documented here.
 *   - Front-run griefing on depositId: an observer could register blind_addr
 *     before Alice. Negligible on low-traffic testnet; for mainnet consider
 *     private mempool submission (e.g. Flashbots).
 *
 * Hash-to-G1 (PoC): try-and-increment on **nullifier address only** (20 bytes), matching
 * `ghost_library.hash_to_curve(spend_address_bytes)`.
 *   keccak256(nullifier_20 || be32(counter)) on curve y^2 = x^3 + 3.
 */
contract GhostVault {

    // -- Constants --------------------------------------------------------------

    /// @dev BN254 (alt_bn128) field modulus.
    uint256 internal constant P =
        21888242871839275222246405745257275088696311157297823662689037894645226208583;

    /// @dev BN254 curve order q.  r = blind_priv mod BN254_ORDER on the client.
    uint256 internal constant BN254_ORDER =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    uint256 public constant DENOMINATION   = 0.001 ether;
    uint256 public constant MAX_H2C_ITERS  = 65536;

    // -- State ------------------------------------------------------------------

    /// @dev BLS public key of the Mint on G2 (EIP-197 limb order).
    uint256[4] public pkMint;

    /// @dev Address authorised to call announce().  Set to Mint's funded account.
    address public immutable mintAuthority;

    /// @dev Tracks spent nullifiers (spend_addr) to prevent double-spend.
    mapping(address => bool) public spentNullifiers;

    /// @dev depositId (blind_addr) => deposit registered and not yet fulfilled by mint.
    mapping(address => bool) internal awaitingFulfillment;

    /// @dev depositId (blind_addr) => true once MintFulfilled has been emitted.
    mapping(address => bool) internal announced;

    /// @dev depositId => EOA that called `deposit()` (required for `refund`).
    mapping(address => address) public depositors;

    // -- Events -----------------------------------------------------------------

    /// @dev Emitted when a deposit is locked.
    ///      depositId = blind.address derived from the blind keypair.
    ///      No msg.sender in event.  Clients recover deposits by computing
    ///      blind_addr_i from seed and querying this event by depositId directly.
    event DepositLocked(address indexed depositId, uint256[2] B);

    /// @dev Emitted by the Mint after blind signing.
    ///      S' is safe in plaintext — useless without the blinding factor r.
    event MintFulfilled(address indexed depositId, uint256[2] S_prime);

    /// @dev Emitted when a token is redeemed.
    event Redeemed(address indexed nullifier, address indexed recipient);

    /// @dev Emitted when a pending deposit is refunded to the original depositor.
    event Refunded(address indexed depositId, address indexed to);

    // -- Errors -----------------------------------------------------------------

    error InvalidValue();
    error InvalidECDSA();
    error AlreadySpent();
    error InvalidBLS();
    error InvalidSignatureLength();
    error EthSendFailed();
    error HashToCurveFailed();
    error NotMintAuthority();
    error DepositNotFound();
    error DepositIdAlreadyUsed();
    error AlreadyFulfilled();
    error InvalidDepositId();
    error NotDepositor();
    error NothingToRefund();

    // -- Constructor ------------------------------------------------------------

    constructor(uint256[4] memory pkMint_, address mintAuthority_) {
        pkMint        = pkMint_;
        mintAuthority = mintAuthority_;
    }

    // -- External: deposit ------------------------------------------------------

    /**
     * @notice Lock 0.001 ETH and register a mint request.
     *
     * @param depositId      blind.address — unique deposit identifier.
     * @param blindedPointB  G1 point B = r * H_G1(spend_addr).
     */
    function deposit(
        address             depositId,
        uint256[2] calldata blindedPointB
    ) external payable {
        if (msg.value != DENOMINATION)             revert InvalidValue();
        if (depositId == address(0))               revert InvalidDepositId();
        if (awaitingFulfillment[depositId] || announced[depositId]) revert DepositIdAlreadyUsed();

        awaitingFulfillment[depositId] = true;
        depositors[depositId] = msg.sender;

        emit DepositLocked(depositId, blindedPointB);
    }

    // -- External: announce -----------------------------------------------------

    /**
     * @notice Called by the Mint to deliver the blind signature S' on-chain.
     */
    function announce(
        address             depositId,
        uint256[2] calldata S_prime
    ) external {
        if (msg.sender != mintAuthority)      revert NotMintAuthority();
        if (announced[depositId])             revert AlreadyFulfilled();
        if (!awaitingFulfillment[depositId]) revert DepositNotFound();

        announced[depositId] = true;
        awaitingFulfillment[depositId] = false;
        emit MintFulfilled(depositId, S_prime);
    }

    /**
     * @notice Reclaim locked ETH if the mint never fulfilled this deposit.
     * @dev Only the account that originally called `deposit()` may refund.
     */
    function refund(address depositId) external {
        if (depositId == address(0)) revert InvalidDepositId();
        if (!awaitingFulfillment[depositId]) revert NothingToRefund();
        if (msg.sender != depositors[depositId]) revert NotDepositor();

        awaitingFulfillment[depositId] = false;
        delete depositors[depositId];

        (bool sent,) = payable(msg.sender).call{value: DENOMINATION}("");
        if (!sent) revert EthSendFailed();

        emit Refunded(depositId, msg.sender);
    }

    // -- External: redeem -------------------------------------------------------

    /**
     * @notice Verify and redeem a token.  Transfers 0.001 ETH to recipient.
     * @param nullifier The spend / nullifier address; must match `ecrecover` on the redemption hash.
     */
    function redeem(
        address             recipient,
        bytes      calldata spendSignature,
        address             nullifier,
        uint256[2] calldata unblindedSignatureS
    ) external {
        bytes32 txHash = redemptionMessageHash(recipient);
        address recoveredNullifier = recoverSigner(txHash, spendSignature);
        if (recoveredNullifier != nullifier) revert InvalidECDSA();

        if (spentNullifiers[nullifier]) revert AlreadySpent();
        spentNullifiers[nullifier] = true;

        uint256[2] memory y = hashNullifierPoint(nullifier);
        if (!verifyBLS(unblindedSignatureS, y, pkMint)) revert InvalidBLS();

        (bool sent,) = payable(recipient).call{value: DENOMINATION}("");
        if (!sent) revert EthSendFailed();
        emit Redeemed(nullifier, recipient);
    }

    // -- Public view helpers ----------------------------------------------------

    function redemptionMessageHash(address recipient) public pure returns (bytes32) {
        return keccak256(abi.encodePacked("Pay to RAW: ", recipient));
    }

    /**
     * @notice Map a nullifier address to a BN254 G1 point via hash-to-curve.
     * @dev    PoC: preimage is the 20-byte address only (matches Python `ghost_library`).
     */
    function hashNullifierPoint(address nullifier) public view returns (uint256[2] memory) {
        return hashToCurve(abi.encodePacked(nullifier));
    }

    function hashToCurve(bytes memory message) public view returns (uint256[2] memory) {
        for (uint256 i = 0; i < MAX_H2C_ITERS; i++) {
            uint256 x   = uint256(keccak256(abi.encodePacked(message, uint32(i)))) % P;
            uint256 rhs = addmod(mulmod(mulmod(x, x, P), x, P), 3, P);
            if (!_legendreIsOne(rhs)) continue;
            uint256 y = _modSqrtFp(rhs);
            if (mulmod(y, y, P) == rhs) return [x, y];
        }
        revert HashToCurveFailed();
    }

    function depositPending(address depositId) external view returns (bool) {
        return awaitingFulfillment[depositId];
    }

    function depositFulfilled(address depositId) external view returns (bool) {
        return announced[depositId];
    }

    // -- Internal: BLS verification ---------------------------------------------

    function verifyBLS(
        uint256[2] memory S,
        uint256[2] memory Y,
        uint256[4] memory PK_mint
    ) internal view returns (bool) {
        uint256[2] memory negY = _negateG1(Y);
        uint256[4] memory g2   = _g2Gen();

        bytes memory input = abi.encodePacked(
            S[0],
            S[1],
            g2[0],
            g2[1],
            g2[2],
            g2[3],
            negY[0],
            negY[1],
            PK_mint[0],
            PK_mint[1],
            PK_mint[2],
            PK_mint[3]
        );

        (bool ok, bytes memory ret) = address(0x08).staticcall(input);
        require(ok, "Pairing precompile failed");
        return abi.decode(ret, (uint256)) == 1;
    }

    function recoverSigner(bytes32 hash, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) revert InvalidSignatureLength();
        bytes32 r;
        bytes32 s;
        uint8   v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        return ecrecover(hash, v, r, s);
    }

    function _negateG1(uint256[2] memory p) internal pure returns (uint256[2] memory) {
        if (p[0] == 0 && p[1] == 0) return [uint256(0), uint256(0)];
        return [p[0], P - (p[1] % P)];
    }

    function _g2Gen() internal pure returns (uint256[4] memory g) {
        g[0] = 0x198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c2;
        g[1] = 0x1800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6ed;
        g[2] = 0x090689d0585ff075ec9e99ad690c3395bc4b313370b38ef355acdadcd122975b;
        g[3] = 0x12c85ea5db8c6deb4aab71808dcb408fe3d1e7690c43d37b4ce6cc0166fa7daa;
    }

    function _legendreIsOne(uint256 rhs) internal view returns (bool) {
        if (rhs == 0) return false;
        return _modExp(rhs, (P - 1) / 2) == 1;
    }

    function _modSqrtFp(uint256 rhs) internal view returns (uint256) {
        return _modExp(rhs, (P + 1) / 4);
    }

    function _modExp(uint256 base, uint256 exponent) internal view returns (uint256 r) {
        assembly {
            let ptr := mload(0x40)
            mstore(ptr,            0x20)
            mstore(add(ptr, 0x20), 0x20)
            mstore(add(ptr, 0x40), 0x20)
            mstore(add(ptr, 0x60), base)
            mstore(add(ptr, 0x80), exponent)
            mstore(add(ptr, 0xa0), P)
            if iszero(staticcall(gas(), 0x05, ptr, 0xc0, ptr, 0x20)) { revert(0, 0) }
            r := mload(ptr)
        }
    }
}
