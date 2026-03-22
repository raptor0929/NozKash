// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {GhostVault} from "../src/GhostVault.sol";

/// @dev Exposes internal `verifyBLS` for vector checks.
contract GhostVaultHarness is GhostVault {
    constructor(uint256[4] memory pkMint_, address mintAuthority_) GhostVault(pkMint_, mintAuthority_) {}

    function exposedVerifyBLS(uint256[2] calldata S, uint256[2] calldata Y, uint256[4] calldata pk_)
        external
        view
        returns (bool)
    {
        return verifyBLS(S, Y, pk_);
    }
}

/// @dev Forks **Avalanche Fuji** C-Chain in `setUp` (public RPC in `foundry.toml` alias `avalanche-fuji`;
///      set `FUJI_RPC_URL` to override). Per-token JSON: default `test/test-vectors/`, or `GHOST_VECTOR_SUITE`.
contract GhostVaultTest is Test {
    using stdJson for string;

    GhostVaultHarness internal vault;
    address internal mintAuthority;

    /// @dev Directory containing `token_<index>.json` (Forge env `GHOST_VECTOR_SUITE`, or default below).
    string internal vectorSuite;

    uint256 internal constant P = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    event MintFulfilled(address indexed depositId, uint256[2] S_prime);

    function setUp() public {
        string memory fujiUrl = vm.envOr("FUJI_RPC_URL", string(""));
        if (bytes(fujiUrl).length > 0) {
            vm.createSelectFork(fujiUrl);
        } else {
            vm.createSelectFork("avalanche-fuji");
        }

        vectorSuite = vm.envOr("GHOST_VECTOR_SUITE", string("test/test-vectors"));
        mintAuthority = makeAddr("mintAuthority");
        string memory j = vm.readFile(_tokenFile(42));
        uint256[4] memory pkMint = _pkMintFromJson(j);
        vault = new GhostVaultHarness(pkMint, mintAuthority);
    }

    function _tokenFile(uint256 tokenIndex) internal view returns (string memory) {
        return string.concat(vectorSuite, "/token_", vm.toString(tokenIndex), ".json");
    }

    function _tokenPaths() internal view returns (string[6] memory p) {
        p[0] = _tokenFile(0);
        p[1] = _tokenFile(1);
        p[2] = _tokenFile(255);
        p[3] = _tokenFile(256);
        p[4] = _tokenFile(42);
        p[5] = _tokenFile(1000);
    }

    /// @dev Left-pad hex (no 0x) to 64 nibbles so uint256 limb parsing matches on-chain precompile inputs.
    function _padHex64(string memory s) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        uint256 skip = 0;
        if (b.length >= 2 && b[0] == 0x30 && (b[1] == 0x78 || b[1] == 0x58)) {
            skip = 2;
        }
        uint256 n = b.length - skip;
        require(n <= 64, "hex field too long");
        bytes memory out = new bytes(64);
        for (uint256 i; i < 64 - n; i++) {
            out[i] = 0x30;
        }
        for (uint256 i; i < n; i++) {
            out[64 - n + i] = b[skip + i];
        }
        return string(out);
    }

    function _hexU256(string memory json, string memory key) internal pure returns (uint256) {
        return vm.parseUint(string.concat("0x", _padHex64(json.readString(key))));
    }

    function _hexBytes(string memory json, string memory key) internal pure returns (bytes memory) {
        return vm.parseBytes(string.concat("0x", json.readString(key)));
    }

    function _pkMintFromJson(string memory j) internal pure returns (uint256[4] memory pkMint) {
        pkMint[0] = _hexU256(j, ".PK_MINT.X_imag");
        pkMint[1] = _hexU256(j, ".PK_MINT.X_real");
        pkMint[2] = _hexU256(j, ".PK_MINT.Y_imag");
        pkMint[3] = _hexU256(j, ".PK_MINT.Y_real");
    }

    function _g1FromJson(string memory j, string memory baseKey) internal pure returns (uint256[2] memory p) {
        p[0] = _hexU256(j, string.concat(baseKey, ".X"));
        p[1] = _hexU256(j, string.concat(baseKey, ".Y"));
    }

    function test_allTestVectors_metadataBlsH2cEcdsaAndRedeem() public {
        string[6] memory paths = _tokenPaths();
        for (uint256 t; t < paths.length; t++) {
            string memory j = vm.readFile(paths[t]);
            _assertTokenCrypto(j);
        }

        vm.deal(address(vault), 6 * vault.DENOMINATION());
        for (uint256 t; t < paths.length; t++) {
            string memory j = vm.readFile(paths[t]);
            _redeemOne(j);
        }
    }

    function _assertTokenCrypto(string memory j) internal view {
        uint256[4] memory pkMint = _pkMintFromJson(j);
        uint256[2] memory s = _g1FromJson(j, ".S_UNBLINDED");
        uint256[2] memory y = _g1FromJson(j, ".Y_HASH_TO_CURVE");
        assertTrue(vault.exposedVerifyBLS(s, y, pkMint));

        address spend = j.readAddress(".SPEND_KEYPAIR.address");
        uint256[2] memory yOnChain = vault.hashNullifierPoint(spend);
        assertEq(yOnChain[0], y[0]);
        assertEq(yOnChain[1], y[1]);

        address recipient = j.readAddress(".REDEEM_TX.recipient");
        assertEq(vault.redemptionMessageHash(recipient), bytes32(_hexU256(j, ".REDEEM_TX.msg_hash")));

        bytes memory sig = _hexBytes(j, ".REDEEM_TX.spend_signature");
        bytes32 msgHash = bytes32(_hexU256(j, ".REDEEM_TX.msg_hash"));
        (bytes32 r, bytes32 s256, uint8 v) = _splitSig(sig);
        address recovered = ecrecover(msgHash, v, r, s256);
        assertEq(recovered, spend, "ECDSA must recover spend_addr");
    }

    function _redeemOne(string memory j) internal {
        address recipient = j.readAddress(".REDEEM_TX.recipient");
        bytes memory sig = _hexBytes(j, ".REDEEM_TX.spend_signature");
        uint256[2] memory sG1 = [j.readUint(".REDEEM_TX.S_x"), j.readUint(".REDEEM_TX.S_y")];

        uint256 balBefore = recipient.balance;
        vault.redeem(recipient, sig, sG1);
        assertEq(recipient.balance - balBefore, vault.DENOMINATION());
        assertTrue(vault.spentNullifiers(j.readAddress(".SPEND_KEYPAIR.address")));
    }

    function _splitSig(bytes memory sig) internal pure returns (bytes32 r, bytes32 s, uint8 v) {
        require(sig.length == 65, "sig len");
        assembly {
            r := mload(add(sig, 0x20))
            s := mload(add(sig, 0x40))
            v := byte(0, mload(add(sig, 0x60)))
        }
    }

    function test_hashNullifierPointOnCurve() public view {
        string memory j = vm.readFile(_tokenFile(42));
        address spend = j.readAddress(".SPEND_KEYPAIR.address");
        uint256[2] memory pt = vault.hashNullifierPoint(spend);
        uint256 x = pt[0];
        uint256 rhs = addmod(mulmod(mulmod(x, x, P), x, P), 3, P);
        assertEq(mulmod(pt[1], pt[1], P), rhs);
    }

    function test_deposit_twoBlindAddrsLockEth() public {
        string memory j = vm.readFile(_tokenFile(42));
        uint256[2] memory b = _g1FromJson(j, ".B_BLINDED");
        address user = makeAddr("depositor");
        address blind1 = makeAddr("blindAddr1");
        address blind2 = makeAddr("blindAddr2");
        vm.deal(user, 2 ether);

        uint256 den = vault.DENOMINATION();
        vm.prank(user);
        vault.deposit{value: den}(blind1, b);
        vm.prank(user);
        vault.deposit{value: den}(blind2, b);

        assertEq(address(vault).balance, 2 * den);
        assertTrue(vault.depositPending(blind1));
        assertTrue(vault.depositPending(blind2));
        assertFalse(vault.depositFulfilled(blind1));
    }

    function test_deposit_revertsWhenWrongValue() public {
        string memory j = vm.readFile(_tokenFile(42));
        uint256[2] memory b = _g1FromJson(j, ".B_BLINDED");
        vm.deal(address(this), 1 ether);
        vm.expectRevert(GhostVault.InvalidValue.selector);
        vault.deposit{value: 0}(makeAddr("blindX"), b);
    }

    function test_deposit_revertsZeroBlindAddr() public {
        string memory j = vm.readFile(_tokenFile(42));
        uint256[2] memory b = _g1FromJson(j, ".B_BLINDED");
        vm.deal(address(this), 1 ether);
        uint256 den = vault.DENOMINATION();
        vm.expectRevert(GhostVault.InvalidDepositId.selector);
        vault.deposit{value: den}(address(0), b);
    }

    function test_deposit_revertsDuplicateBlindAddr() public {
        string memory j = vm.readFile(_tokenFile(42));
        uint256[2] memory b = _g1FromJson(j, ".B_BLINDED");
        address blind = makeAddr("blindDup");
        address user = makeAddr("depositor");
        vm.deal(user, 2 ether);
        uint256 den = vault.DENOMINATION();
        vm.startPrank(user);
        vault.deposit{value: den}(blind, b);
        vm.expectRevert(GhostVault.DepositIdAlreadyUsed.selector);
        vault.deposit{value: den}(blind, b);
        vm.stopPrank();
    }

    function test_announce_emitsMintFulfilled_afterDeposit() public {
        string memory j = vm.readFile(_tokenFile(42));
        uint256[2] memory b = _g1FromJson(j, ".B_BLINDED");
        uint256[2] memory sPrime = _g1FromJson(j, ".S_PRIME");

        address blindId = j.readAddress(".BLIND_KEYPAIR.address");
        address user = makeAddr("depositor");
        vm.deal(user, 1 ether);
        uint256 den = vault.DENOMINATION();
        vm.prank(user);
        vault.deposit{value: den}(blindId, b);

        vm.prank(mintAuthority);
        vm.expectEmit(true, true, true, true);
        emit MintFulfilled(blindId, sPrime);
        vault.announce(blindId, sPrime);

        assertTrue(vault.depositFulfilled(blindId));
        assertFalse(vault.depositPending(blindId));
    }

    function test_announce_revertsNotMintAuthority() public {
        string memory j = vm.readFile(_tokenFile(42));
        uint256[2] memory b = _g1FromJson(j, ".B_BLINDED");

        address blindId = j.readAddress(".BLIND_KEYPAIR.address");
        address user = makeAddr("depositor");
        vm.deal(user, 1 ether);
        uint256 den = vault.DENOMINATION();
        vm.prank(user);
        vault.deposit{value: den}(blindId, b);

        vm.expectRevert(GhostVault.NotMintAuthority.selector);
        vault.announce(blindId, _g1FromJson(j, ".S_PRIME"));
    }

    function test_announce_revertsDepositNotFound() public {
        string memory j = vm.readFile(_tokenFile(42));
        vm.prank(mintAuthority);
        vm.expectRevert(GhostVault.DepositNotFound.selector);
        vault.announce(makeAddr("neverDeposited"), _g1FromJson(j, ".S_PRIME"));
    }

    function test_announce_revertsAlreadyFulfilled() public {
        string memory j = vm.readFile(_tokenFile(42));
        uint256[2] memory b = _g1FromJson(j, ".B_BLINDED");
        uint256[2] memory sPrime = _g1FromJson(j, ".S_PRIME");

        address blindId = j.readAddress(".BLIND_KEYPAIR.address");
        address user = makeAddr("depositor");
        vm.deal(user, 1 ether);
        uint256 den = vault.DENOMINATION();
        vm.prank(user);
        vault.deposit{value: den}(blindId, b);

        vm.startPrank(mintAuthority);
        vault.announce(blindId, sPrime);
        vm.expectRevert(GhostVault.AlreadyFulfilled.selector);
        vault.announce(blindId, sPrime);
        vm.stopPrank();
    }

    function test_redeem_succeedsAgainstVectors() public {
        string memory j = vm.readFile(_tokenFile(42));
        address recipient = j.readAddress(".REDEEM_TX.recipient");
        bytes memory sig = _hexBytes(j, ".REDEEM_TX.spend_signature");
        uint256[2] memory sG1 = [j.readUint(".REDEEM_TX.S_x"), j.readUint(".REDEEM_TX.S_y")];

        vm.deal(address(vault), vault.DENOMINATION());
        uint256 balBefore = recipient.balance;

        vault.redeem(recipient, sig, sG1);

        assertEq(recipient.balance - balBefore, vault.DENOMINATION());
        assertTrue(vault.spentNullifiers(j.readAddress(".SPEND_KEYPAIR.address")));
    }

    function test_redeem_revertsDoubleSpend() public {
        string memory j = vm.readFile(_tokenFile(42));
        address recipient = j.readAddress(".REDEEM_TX.recipient");
        bytes memory sig = _hexBytes(j, ".REDEEM_TX.spend_signature");
        uint256[2] memory sG1 = [j.readUint(".REDEEM_TX.S_x"), j.readUint(".REDEEM_TX.S_y")];

        vm.deal(address(vault), 2 * vault.DENOMINATION());
        vault.redeem(recipient, sig, sG1);

        vm.expectRevert(GhostVault.AlreadySpent.selector);
        vault.redeem(recipient, sig, sG1);
    }

    function test_redeem_revertsInvalidECDSA() public {
        string memory j = vm.readFile(_tokenFile(42));
        address recipient = j.readAddress(".REDEEM_TX.recipient");
        uint256[2] memory sG1 = [j.readUint(".REDEEM_TX.S_x"), j.readUint(".REDEEM_TX.S_y")];
        bytes memory badSig = new bytes(65);
        for (uint256 i; i < 65; i++) {
            badSig[i] = 0xab;
        }

        vm.deal(address(vault), vault.DENOMINATION());
        vm.expectRevert(GhostVault.InvalidECDSA.selector);
        vault.redeem(recipient, badSig, sG1);
    }

    function test_redeem_revertsInvalidBLS() public {
        string memory j = vm.readFile(_tokenFile(42));
        address recipient = j.readAddress(".REDEEM_TX.recipient");
        bytes memory sig = _hexBytes(j, ".REDEEM_TX.spend_signature");
        uint256[2] memory badS = [uint256(1), uint256(2)];

        vm.deal(address(vault), vault.DENOMINATION());
        vm.expectRevert(GhostVault.InvalidBLS.selector);
        vault.redeem(recipient, sig, badS);
    }
}
