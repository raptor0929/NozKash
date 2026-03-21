"""
Ghost-Tip Protocol: CLI Wallet

Reference implementation of the full client lifecycle. Each command maps to
one phase of the protocol and prints every intermediate cryptographic value
so the output can be used as a debugging reference when building other clients.

Commands:
    deposit   Blind a token and submit a deposit transaction to GhostVault
    scan      Scan chain events to find and recover pending/spendable tokens
    redeem    Unblind a recovered token and redeem it to a destination address
    status    Show wallet state: known tokens, spent nullifiers, balances
    balance   Query on-chain ETH balance for the wallet address

Configuration (.env):
    MASTER_SEED             Hex string seed (from generate_keys.py)
    WALLET_ADDRESS          Ethereum address that pays gas for deposit/redeem
    WALLET_KEY              Private key for the above (hex, with or without 0x)
    CONTRACT_ADDRESS        Deployed GhostVault contract address
    RPC_HTTP_URL            HTTP RPC endpoint (e.g. https://sepolia.infura.io/...)
    SCAN_FROM_BLOCK         Block to start scanning from (default: 0)

Usage:
    uv run client.py deposit --index 0
    uv run client.py scan --from-block 7000000 --index-from 0 --index-to 9
    uv run client.py redeem --index 0 --to 0xRecipientAddress
    uv run client.py status
    uv run client.py balance
"""

import json
import logging
import os
import sys
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Annotated, Optional

import requests
import typer
from dotenv import load_dotenv
from web3 import Web3

from ghost_library import (
    G1Point, G2Point, Scalar,
    derive_token_secrets, blind_token, unblind_signature,
    generate_redemption_proof, serialize_g1, parse_g1,
    verify_bls_pairing, verify_ecdsa_mev_protection,
    GhostError, InvalidPointError,
)

load_dotenv()

# ==============================================================================
# LOGGING — verbose, structured, with section banners
# ==============================================================================

logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("ghost_client")

DENOMINATION_WEI = 10_000_000_000_000_000  # 0.01 ETH


def banner(title: str) -> None:
    log.info("")
    log.info("━" * 60)
    log.info("  %s", title)
    log.info("━" * 60)


def section(title: str) -> None:
    log.info("")
    log.info("── %s", title)


def field_log(name: str, value: str) -> None:
    log.info("    %-28s %s", name + ":", value)


# ==============================================================================
# WALLET STATE  (persisted to .ghost_wallet.json)
# ==============================================================================

WALLET_STATE_FILE = Path(".ghost_wallet.json")


@dataclass
class TokenRecord:
    """Persisted record for a single token across its full lifecycle."""
    index:         int
    spend_address: str              # Nullifier — the spend keypair address
    deposit_id:    str              # Deposit ID — the blind keypair address (deterministic)
    deposit_tx:    Optional[str] = None   # Deposit transaction hash
    deposit_block: Optional[int] = None
    s_unblinded_x: Optional[str] = None  # Hex — recovered after unblinding S'
    s_unblinded_y: Optional[str] = None
    redeem_tx:     Optional[str] = None
    spent:         bool = False

    @property
    def has_token(self) -> bool:
        return self.s_unblinded_x is not None

    @property
    def status(self) -> str:
        if self.spent:
            return "SPENT"
        if self.has_token:
            return "READY_TO_REDEEM"
        return "AWAITING_MINT" if self.deposit_tx else "FRESH"


@dataclass
class WalletState:
    tokens: dict[int, TokenRecord] = field(default_factory=dict)
    last_scanned_block: int = 0

    def save(self) -> None:
        data = {
            "tokens": {
                str(idx): asdict(rec)
                for idx, rec in self.tokens.items()
            },
            "last_scanned_block": self.last_scanned_block,
        }
        WALLET_STATE_FILE.write_text(json.dumps(data, indent=2))
        log.debug("Wallet state saved to %s", WALLET_STATE_FILE)

    @classmethod
    def load(cls) -> "WalletState":
        if not WALLET_STATE_FILE.exists():
            return cls()
        data = json.loads(WALLET_STATE_FILE.read_text())
        tokens = {
            int(idx): TokenRecord(**rec)
            for idx, rec in data.get("tokens", {}).items()
        }
        return cls(
            tokens=tokens,
            last_scanned_block=data.get("last_scanned_block", 0),
        )


# ==============================================================================
# CONFIGURATION
# ==============================================================================

@dataclass(frozen=True)
class ClientConfig:
    master_seed:      bytes
    wallet_address:   str
    wallet_key:       str
    contract_address: str
    rpc_http_url:     str
    scan_from_block:  int


def load_config() -> ClientConfig:
    missing = []

    def require(key: str) -> str:
        val = os.getenv(key, "").strip()
        if not val:
            missing.append(key)
        return val

    seed_hex     = require("MASTER_SEED")
    wallet_addr  = require("WALLET_ADDRESS")
    wallet_key   = require("WALLET_KEY")
    contract     = require("CONTRACT_ADDRESS")
    rpc_url      = require("RPC_HTTP_URL")

    if missing:
        log.error("Missing required .env variables: %s", ", ".join(missing))
        log.error("Run generate_keys.py to create a .env, then add WALLET_ADDRESS,")
        log.error("WALLET_KEY, CONTRACT_ADDRESS, and RPC_HTTP_URL.")
        sys.exit(1)

    return ClientConfig(
        master_seed=seed_hex.encode("utf-8"),
        wallet_address=wallet_addr,
        wallet_key=wallet_key if wallet_key.startswith("0x") else "0x" + wallet_key,
        contract_address=contract,
        rpc_http_url=rpc_url,
        scan_from_block=int(os.getenv("SCAN_FROM_BLOCK", "0")),
    )


# ==============================================================================
# CONTRACT ABI
# ==============================================================================

GHOST_VAULT_ABI = [
    {
        "name": "DepositLocked",
        "type": "event",
        "inputs": [
            {"name": "depositId", "type": "address",    "indexed": True},
            {"name": "B",         "type": "uint256[2]", "indexed": False},
        ],
    },
    {
        "name": "MintFulfilled",
        "type": "event",
        "inputs": [
            {"name": "depositId",        "type": "address",    "indexed": True},
            {"name": "blindedSignature", "type": "uint256[2]", "indexed": False},
        ],
    },
    {
        "name": "deposit",
        "type": "function",
        "stateMutability": "payable",
        "inputs": [
            {"name": "blindedPointB", "type": "uint256[2]"},
            {"name": "depositId",     "type": "address"},
        ],
        "outputs": [],
    },
    {
        "name": "redeem",
        "type": "function",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "recipient",          "type": "address"},
            {"name": "spendSignature",     "type": "bytes"},
            {"name": "unblindedSignatureS","type": "uint256[2]"},
        ],
        "outputs": [],
    },
    {
        "name": "spentNullifiers",
        "type": "function",
        "stateMutability": "view",
        "inputs": [{"name": "", "type": "address"}],
        "outputs": [{"name": "", "type": "bool"}],
    },
]


# ==============================================================================
# HELPERS
# ==============================================================================

def encode_spend_signature(compact_hex: str, recovery_bit: int) -> bytes:
    """
    Encodes the ECDSA signature for Solidity ecrecover.

    Solidity's ecrecover expects 65 bytes: r (32) + s (32) + v (1)
    where v = recovery_bit + 27.

    The compact_hex from ghost_library is already r||s as 128 hex chars.
    """
    r_bytes = bytes.fromhex(compact_hex[:64])
    s_bytes = bytes.fromhex(compact_hex[64:])
    v_byte  = bytes([recovery_bit + 27])
    return r_bytes + s_bytes + v_byte


def build_web3(config: ClientConfig) -> Web3:
    w3 = Web3(Web3.HTTPProvider(config.rpc_http_url))
    if not w3.is_connected():
        log.error("Cannot connect to RPC: %s", config.rpc_http_url)
        raise typer.Exit(code=1)
    return w3


# ==============================================================================
# COMMAND: deposit
# ==============================================================================

def cmd_deposit(config: ClientConfig, token_index: int) -> None:
    banner(f"DEPOSIT  —  Token Index {token_index}")

    state = WalletState.load()
    w3    = build_web3(config)

    # ── Step 1: Derive token secrets ──────────────────────────────────────────
    section("Step 1 · Derive Token Secrets")
    secrets = derive_token_secrets(config.master_seed, token_index)

    field_log("Token index",    str(token_index))
    field_log("Spend address",  secrets.spend.address)
    field_log("Blind address",  secrets.blind.address)
    field_log("Blinding r",     hex(secrets.r))
    log.info("")
    log.info("    Spend address: nullifier — revealed only at redemption.")
    log.info("    Blind address: deposit ID — submitted with deposit tx.")
    log.info("    Neither reveals the other without the master seed.")

    # ── Step 2: Blind the token ───────────────────────────────────────────────
    section("Step 2 · Blind Token → G1")
    blinded = blind_token(secrets.spend_address_bytes, secrets.r)
    b_x, b_y = serialize_g1(blinded.B)
    y_x, y_y = serialize_g1(blinded.Y)

    field_log("Y = H(spend_addr) x", hex(y_x))
    field_log("Y = H(spend_addr) y", hex(y_y))
    field_log("B = r·Y  x",          hex(b_x))
    field_log("B = r·Y  y",          hex(b_y))
    log.info("")
    log.info("    B is the blinded point sent to the contract.")
    log.info("    The mint cannot derive the spend address from B without r.")

    # ── Step 3: Simulate deposit_id ───────────────────────────────────────────
    section("Step 3 · Deposit ID")
    # The deposit ID is the blind keypair's Ethereum address — deterministic,
    # re-derivable from the seed alone, and submitted with the deposit tx so
    # the contract can index the deposit without generating its own ID.
    field_log("Deposit ID", secrets.deposit_id)

    # ── Step 4: Submit deposit transaction ────────────────────────────────────
    section("Step 4 · Submit deposit() Transaction")

    contract = w3.eth.contract(
        address=Web3.to_checksum_address(config.contract_address),
        abi=GHOST_VAULT_ABI,
    )
    wallet = Web3.to_checksum_address(config.wallet_address)

    nonce     = w3.eth.get_transaction_count(wallet)
    gas_price = w3.eth.gas_price
    balance   = w3.eth.get_balance(wallet)

    field_log("Wallet address",  wallet)
    field_log("Wallet balance",  f"{Web3.from_wei(balance, 'ether'):.6f} ETH")
    field_log("Nonce",           str(nonce))
    field_log("Gas price",       f"{Web3.from_wei(gas_price, 'gwei'):.2f} gwei")
    field_log("Deposit amount",  "0.01 ETH")

    if balance < DENOMINATION_WEI:
        log.error("Insufficient balance: need at least 0.01 ETH")
        raise typer.Exit(code=1)

    tx = contract.functions.deposit([b_x, b_y], Web3.to_checksum_address(secrets.deposit_id)).build_transaction({
        "from":     wallet,
        "value":    DENOMINATION_WEI,
        "nonce":    nonce,
        "gasPrice": gas_price,
    })

    signed   = w3.eth.account.sign_transaction(tx, private_key=config.wallet_key)
    tx_hash  = w3.eth.send_raw_transaction(signed.raw_transaction)
    tx_hex   = tx_hash.hex()

    field_log("Transaction sent", tx_hex)
    log.info("    Waiting for confirmation...")

    receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)

    if receipt["status"] != 1:
        log.error("Transaction REVERTED  tx=%s", tx_hex)
        raise typer.Exit(code=1)

    field_log("Confirmed at block", str(receipt["blockNumber"]))
    field_log("Gas used",           str(receipt["gasUsed"]))

    field_log("Deposit ID confirmed", secrets.deposit_id)
    log.info("    DepositLocked emitted. The mint server will now")
    log.info("    sign B and call announce(depositId, S').")

    # ── Persist ───────────────────────────────────────────────────────────────
    state.tokens[token_index] = TokenRecord(
        index=token_index,
        spend_address=secrets.spend.address,
        deposit_id=secrets.deposit_id,
        deposit_tx=tx_hex,
        deposit_block=receipt["blockNumber"],
    )
    state.save()

    log.info("")
    log.info("✅  Deposit complete. Next: run 'scan' to recover the signed token.")


# ==============================================================================
# COMMAND: scan
# ==============================================================================

def cmd_scan(
    config: ClientConfig,
    from_block: Optional[int],
    index_from: int,
    index_to: int,
) -> None:
    banner(f"SCAN  —  Tokens {index_from}–{index_to}")

    state    = WalletState.load()
    w3       = build_web3(config)
    contract = w3.eth.contract(
        address=Web3.to_checksum_address(config.contract_address),
        abi=GHOST_VAULT_ABI,
    )

    start_block  = from_block if from_block is not None else state.last_scanned_block
    latest_block = w3.eth.block_number

    field_log("Scanning blocks",   f"{start_block} → {latest_block}")
    field_log("Token indices",     f"{index_from} – {index_to}")
    log.info("")

    # ── Step 1: Fetch all MintFulfilled events in range ───────────────────────
    section("Step 1 · Fetch MintFulfilled Events")

    fulfilled_events = contract.events.MintFulfilled().get_logs(
        from_block=start_block,
        to_block=latest_block,
    )
    field_log("MintFulfilled events found", str(len(fulfilled_events)))

    # Build a lookup: depositId (address) → blinded_signature coords
    fulfilled: dict[str, tuple[int, int]] = {}
    for evt in fulfilled_events:
        did = Web3.to_checksum_address(evt["args"]["depositId"])
        sig = evt["args"]["blindedSignature"]
        fulfilled[did] = (int(sig[0]), int(sig[1]))
        log.debug("    MintFulfilled  depositId=%s  S'.x=0x%x...", did, sig[0] >> 240)

    # ── Step 2: Derive secrets and look up each token by its deposit ID ───────
    # The deposit ID is the blind keypair address — deterministic, no B-matching needed.
    section("Step 2 · Match Tokens by Deposit ID")

    scan_indices = range(index_from, index_to + 1)
    recovered = 0

    for idx in scan_indices:
        log.info("")
        log.info("  ── Token %d ──", idx)

        secrets = derive_token_secrets(config.master_seed, idx)
        deposit_id = Web3.to_checksum_address(secrets.deposit_id)

        field_log("  Spend address", secrets.spend.address)
        field_log("  Deposit ID",    deposit_id)

        # Check if mint has responded for this deposit ID
        if deposit_id not in fulfilled:
            log.info("  No MintFulfilled for deposit ID %s in this block range", deposit_id)
            if idx not in state.tokens:
                state.tokens[idx] = TokenRecord(
                    index=idx,
                    spend_address=secrets.spend.address,
                    deposit_id=deposit_id,
                )
            continue

        s_prime_x, s_prime_y = fulfilled[deposit_id]
        field_log("  S'.x (blind sig)", hex(s_prime_x))
        field_log("  S'.y (blind sig)", hex(s_prime_y))

        # ── Step 4: Unblind the signature ──────────────────────────────────
        log.info("  Unblinding: S = S' · r⁻¹ mod q ...")

        S_prime = parse_g1(s_prime_x, s_prime_y)
        S       = unblind_signature(S_prime, secrets.r)
        s_x, s_y = serialize_g1(S)

        field_log("  S.x (unblinded)",   hex(s_x))
        field_log("  S.y (unblinded)",   hex(s_y))

        # ── Step 5: Local BLS pairing verification ────────────────────────
        # We need PK_mint to verify. For now, verify structure is sound.
        # Full pairing check is done in cmd_redeem with the actual PK_mint.
        log.info("  Token unblinded successfully.")
        log.info("  BLS pairing will be verified at redemption time.")

        # ── Step 6: Check nullifier on-chain ──────────────────────────────
        nullifier_addr = Web3.to_checksum_address(secrets.spend.address)
        is_spent = contract.functions.spentNullifiers(nullifier_addr).call()
        field_log("  Nullifier spent on-chain", str(is_spent))

        rec = state.tokens.get(idx, TokenRecord(
            index=idx,
            spend_address=secrets.spend.address,
            deposit_id=deposit_id,
        ))
        rec.s_unblinded_x = hex(s_x)
        rec.s_unblinded_y = hex(s_y)
        rec.spent         = is_spent
        state.tokens[idx] = rec
        recovered += 1

        status = "SPENT (already redeemed on-chain)" if is_spent else "READY_TO_REDEEM"
        field_log("  Token status", status)

    state.last_scanned_block = latest_block
    state.save()

    log.info("")
    log.info("━" * 60)
    log.info("  Scan complete.  %d token(s) recovered.  Block %d saved.",
             recovered, latest_block)


# ==============================================================================
# COMMAND: redeem
# ==============================================================================

def cmd_redeem(config: ClientConfig, token_index: int, recipient: str, relayer_url: str | None = None) -> None:
    banner(f"REDEEM  —  Token Index {token_index}  →  {recipient}")

    state = WalletState.load()
    w3    = build_web3(config)

    if token_index not in state.tokens:
        log.error("Token %d not found in wallet state. Run 'scan' first.", token_index)
        raise typer.Exit(code=1)

    rec = state.tokens[token_index]

    if rec.spent:
        log.error("Token %d is already spent (nullifier recorded on-chain).", token_index)
        raise typer.Exit(code=1)

    if not rec.has_token:
        log.error("Token %d has no unblinded signature. Run 'scan' first.", token_index)
        raise typer.Exit(code=1)

    # ── Step 1: Reconstruct unblinded signature from state ────────────────────
    section("Step 1 · Load Unblinded Signature from Wallet State")

    s_x = int(rec.s_unblinded_x, 16)
    s_y = int(rec.s_unblinded_y, 16)
    S   = parse_g1(s_x, s_y)

    field_log("S.x", hex(s_x))
    field_log("S.y", hex(s_y))

    # ── Step 2: Derive token secrets for the spend key ────────────────────────
    section("Step 2 · Derive Spend Key")

    secrets = derive_token_secrets(config.master_seed, token_index)
    field_log("Spend address (nullifier)", secrets.spend.address)
    field_log("Blind address (deposit ID)",  secrets.blind.address)
    log.info("")
    log.info("    The spend address is the nullifier. The contract records it")
    log.info("    as spent after this redemption to prevent double-spending.")

    # ── Step 3: Local BLS verification (pre-flight check) ────────────────────
    section("Step 3 · Pre-flight BLS Verification")
    blinded = blind_token(secrets.spend_address_bytes, secrets.r)
    log.info("    Re-deriving Y = H(spend_address) for pairing check...")
    log.info("    Note: full pairing requires PK_mint — skipped here if not")
    log.info("    available. The contract will enforce this on-chain.")
    log.info("    (Add PK_MINT to .env for local pre-flight pairing check.)")

    pk_mint_hex = os.getenv("PK_MINT_X_REAL")
    if pk_mint_hex:
        log.info("    PK_mint found in env — running local pairing verification...")
        try:
            from ghost_library import G2Point, _mul_g2
            from py_ecc.bn128 import G2
            pk_mint_sk = Scalar(int(os.getenv("MINT_BLS_PRIVKEY", "0"), 16))
            if pk_mint_sk:
                pk_mint = _mul_g2(G2Point(G2), pk_mint_sk)
                ok = verify_bls_pairing(S, blinded.Y, pk_mint)
                field_log("Local BLS pairing", "✅ VALID" if ok else "❌ INVALID")
                if not ok:
                    log.error("BLS pairing failed locally — token may be invalid.")
                    raise typer.Exit(code=1)
        except Exception as e:
            log.warning("    Local pairing check skipped: %s", e)
    else:
        log.info("    Skipping local pairing check (MINT_BLS_PRIVKEY not set).")

    # ── Step 4: Generate redemption proof (ECDSA anti-MEV signature) ─────────
    section("Step 4 · Generate Redemption Proof (Anti-MEV ECDSA Signature)")

    recipient_checksum = Web3.to_checksum_address(recipient)
    proof = generate_redemption_proof(secrets.spend_priv, recipient_checksum)

    field_log("Payload",        f"\"Pay to: {recipient_checksum}\"")
    field_log("msg_hash",       proof.msg_hash.hex())
    field_log("compact_hex",    "0x" + proof.compact_hex)
    field_log("recovery_bit",   str(proof.recovery_bit))
    log.info("")
    log.info("    The contract will call ecrecover on this signature.")
    log.info("    The recovered address must match the spend address (nullifier).")
    log.info("    This prevents MEV bots from changing the recipient address.")

    # Verify locally that ecrecover produces the correct nullifier
    is_valid = verify_ecdsa_mev_protection(
        proof.msg_hash,
        proof.compact_hex,
        proof.recovery_bit,
        secrets.spend.address,
    )
    field_log("Local ecrecover check", "✅ VALID" if is_valid else "❌ INVALID")
    if not is_valid:
        log.error("Local ECDSA verification failed — aborting.")
        raise typer.Exit(code=1)

    # Encode for Solidity: 65 bytes = r(32) + s(32) + v(1), v = recovery_bit + 27
    spend_sig_bytes = encode_spend_signature(proof.compact_hex, proof.recovery_bit)
    field_log("Encoded sig (65 bytes)", "0x" + spend_sig_bytes.hex())
    field_log("v (EVM)",                str(proof.recovery_bit + 27))

    # ── Step 5: Build redeem() calldata ─────────────────────────────────────
    # ABI-encoded calldata is the same regardless of who submits. The relayer
    # path wraps it in its own transaction (gas charged to relayer wallet).
    # The direct path signs and submits from the client wallet.
    section("Step 5 · Build redeem() Calldata")

    contract = w3.eth.contract(
        address=Web3.to_checksum_address(config.contract_address),
        abi=GHOST_VAULT_ABI,
    )

    # Use zero address as `from` placeholder — only needed for calldata encoding.
    ZERO = "0x0000000000000000000000000000000000000000"
    calldata = contract.functions.redeem(
        recipient_checksum,
        spend_sig_bytes,
        [s_x, s_y],
    ).build_transaction({"from": ZERO})["data"]

    field_log("Recipient",        recipient_checksum)
    field_log("S.x",              str(s_x))
    field_log("S.y",              str(s_y))
    field_log("Calldata size",    f"{len(bytes.fromhex(calldata[2:]))} bytes")
    field_log("Calldata prefix",  calldata[:18] + "...")

    if relayer_url:
        # ── Relayer path ──────────────────────────────────────────────────────
        # Client sends calldata only — relayer signs and pays gas from its wallet.
        section("Step 6a · Broadcast via Relayer (relayer pays gas)")
        field_log("Relayer URL", relayer_url)
        log.info("    Sending calldata to relayer — no local ETH required.")

        try:
            resp = requests.post(
                relayer_url.rstrip("/") + "/relay",
                json={"calldata": calldata},
                timeout=180,
            )
        except requests.exceptions.ConnectionError as exc:
            log.error("Cannot connect to relayer at %s: %s", relayer_url, exc)
            raise typer.Exit(code=1) from exc

        if not resp.ok:
            log.error("Relayer returned %d: %s", resp.status_code, resp.text)
            raise typer.Exit(code=1)

        result = resp.json()
        tx_hex = result["tx_hash"]
        field_log("Transaction hash",   tx_hex)
        field_log("Confirmed at block", str(result["block_number"]))
        field_log("Gas used",           str(result["gas_used"]))

    else:
        # ── Direct path ───────────────────────────────────────────────────────
        # Client signs and broadcasts its own transaction, paying gas itself.
        section("Step 6b · Broadcast Directly from Wallet")

        wallet    = Web3.to_checksum_address(config.wallet_address)
        nonce     = w3.eth.get_transaction_count(wallet)
        gas_price = w3.eth.gas_price

        field_log("Caller (pays gas)", wallet)
        field_log("Nonce",             str(nonce))
        field_log("Gas price",         f"{Web3.from_wei(gas_price, 'gwei'):.2f} gwei")

        tx = contract.functions.redeem(
            recipient_checksum,
            spend_sig_bytes,
            [s_x, s_y],
        ).build_transaction({
            "from":     wallet,
            "nonce":    nonce,
            "gasPrice": gas_price,
        })

        signed  = w3.eth.account.sign_transaction(tx, private_key=config.wallet_key)
        tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
        tx_hex  = tx_hash.hex()

        field_log("Transaction sent", tx_hex)
        log.info("    Waiting for confirmation...")

        receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)

        if receipt["status"] != 1:
            log.error("Transaction REVERTED  tx=%s", tx_hex)
            log.error("Possible causes: token already spent, invalid BLS pairing,")
            log.error("invalid ECDSA signature, or wrong recovery bit.")
            raise typer.Exit(code=1)

        field_log("Confirmed at block", str(receipt["blockNumber"]))
        field_log("Gas used",           str(receipt["gasUsed"]))

    log.info("")
    log.info("    On-chain checks passed:")
    log.info("      ✅  ecrecover → nullifier matches spend address")
    log.info("      ✅  spentNullifiers[nullifier] was false")
    log.info("      ✅  ecPairing: e(S, G2) == e(H(nullifier), PK_mint)")
    log.info("      ✅  0.01 ETH transferred to %s", recipient_checksum)

    # ── Persist ───────────────────────────────────────────────────────────────
    rec.redeem_tx = tx_hex
    rec.spent     = True
    state.save()

    log.info("")
    log.info("✅  Redemption complete. Token %d is now spent.", token_index)


# ==============================================================================
# COMMAND: status
# ==============================================================================

def cmd_status(config: ClientConfig) -> None:
    banner("WALLET STATUS")

    state = WalletState.load()
    w3    = build_web3(config)

    wallet  = Web3.to_checksum_address(config.wallet_address)
    balance = w3.eth.get_balance(wallet)

    section("On-chain Balance")
    field_log("Wallet address", wallet)
    field_log("ETH balance",    f"{Web3.from_wei(balance, 'ether'):.6f} ETH")

    section("Token Records")
    if not state.tokens:
        log.info("    No tokens in wallet state. Run 'deposit' to create one.")
        return

    field_log("Last scanned block", str(state.last_scanned_block))
    log.info("")

    for idx in sorted(state.tokens):
        rec = state.tokens[idx]
        log.info("  Token %-4d  %-20s  spend=%s",
                 idx, rec.status, rec.spend_address)
        if rec.deposit_id:
            log.info("             deposit_id=%s  tx=%s",
                     rec.deposit_id, rec.deposit_tx or "—")
        if rec.has_token:
            log.info("             S.x=%s...", rec.s_unblinded_x[:18])
        if rec.redeem_tx:
            log.info("             redeem_tx=%s", rec.redeem_tx)


# ==============================================================================
# COMMAND: balance
# ==============================================================================

def cmd_balance(config: ClientConfig) -> None:
    banner("BALANCE CHECK")

    w3      = build_web3(config)
    wallet  = Web3.to_checksum_address(config.wallet_address)
    balance = w3.eth.get_balance(wallet)

    field_log("Address", wallet)
    field_log("Balance", f"{Web3.from_wei(balance, 'ether'):.8f} ETH")
    field_log("Wei",     str(balance))


# ==============================================================================
# TYPER APP
# ==============================================================================

app = typer.Typer(
    name="ghost-wallet",
    help="Ghost-Tip Protocol CLI Wallet — reference implementation of the full eCash lifecycle.",
    no_args_is_help=True,
)


@app.command()
def deposit(
    index: Annotated[int, typer.Option(
        "--index", "-i",
        help="Token index (0-based, must be unique per seed).",
        min=0,
    )],
) -> None:
    """Blind a token secret and submit a deposit transaction to GhostVault."""
    cmd_deposit(load_config(), index)


@app.command()
def scan(
    from_block: Annotated[Optional[int], typer.Option(
        "--from-block",
        help="Block to start scanning from. Defaults to last scanned block.",
        min=0,
    )] = None,
    index_from: Annotated[int, typer.Option(
        "--index-from",
        help="First token index to scan (inclusive).",
        min=0,
    )] = 0,
    index_to: Annotated[int, typer.Option(
        "--index-to",
        help="Last token index to scan (inclusive).",
        min=0,
    )] = 9,
) -> None:
    """Scan chain for MintFulfilled events and recover tokens in index range [index-from, index-to]."""
    if index_to < index_from:
        typer.echo(f"Error: --index-to ({index_to}) must be >= --index-from ({index_from})", err=True)
        raise typer.Exit(code=1)
    cmd_scan(load_config(), from_block, index_from, index_to)


@app.command()
def redeem(
    index: Annotated[int, typer.Option(
        "--index", "-i",
        help="Token index to redeem.",
        min=0,
    )],
    to: Annotated[str, typer.Option(
        "--to",
        help="Recipient Ethereum address.",
    )],
    relayer: Annotated[Optional[str], typer.Option(
        "--relayer",
        help=(
            "Relayer base URL (e.g. http://localhost:8000). "
            "When set, the relayer pays gas — no local ETH required."
        ),
    )] = None,
) -> None:
    """Unblind a recovered token and submit redeem() directly or via a relayer."""
    cmd_redeem(load_config(), index, to, relayer)


@app.command()
def status() -> None:
    """Show wallet state: token lifecycle statuses and on-chain balance."""
    cmd_status(load_config())


@app.command()
def balance() -> None:
    """Query on-chain ETH balance for the configured wallet address."""
    cmd_balance(load_config())


if __name__ == "__main__":
    app()
