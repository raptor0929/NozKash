"""
Ghost-Tip Protocol: Contract Error Decoder

Decodes GhostVault custom error selectors (4-byte EVM revert data) into
human-readable names with diagnostic hints. Used by client.py and
mint_server.py to replace opaque hex like '0x28739233' with
'InvalidBLS — the BLS pairing check failed on-chain'.

The selector table is built from ghost_vault_abi.json at import time.
Adding a new error to the Solidity contract + ABI automatically makes it
decodable here — no manual hex constants needed.

Usage:
    from contract_errors import decode_contract_error

    # From a web3 ContractCustomError or ContractLogicError:
    decoded = decode_contract_error(exc)
    print(decoded)  # "InvalidBLS — the BLS pairing check failed on-chain"

    # From raw hex data:
    decoded = decode_contract_error("0x28739233")
    print(decoded)  # same
"""

import json
from pathlib import Path

from eth_utils import keccak


# ── Build selector → name mapping from ABI ────────────────────────────────────

_ABI_PATH = Path(__file__).resolve().parent / ".." / "sol" / "ghost_vault_abi.json"
_abi = json.loads(_ABI_PATH.read_text())

# keccak256("ErrorName()")[:4] → "ErrorName"
_SELECTOR_TO_NAME: dict[str, str] = {}
for entry in _abi:
    if entry.get("type") == "error":
        name = entry["name"]
        # Custom errors with no params: selector = keccak256("Name()")[:4]
        sig = f"{name}()"
        selector = keccak(sig.encode("utf-8"))[:4].hex()
        _SELECTOR_TO_NAME[selector] = name


# ── Diagnostic hints per error name ───────────────────────────────────────────

_HINTS: dict[str, str] = {
    "InvalidValue":            "msg.value must be exactly 0.001 ETH (DENOMINATION)",
    "InvalidECDSA":            "ecrecover returned address(0) — spend signature is malformed or msg_hash doesn't match the contract's redemptionMessageHash()",
    "AlreadySpent":            "this nullifier (spend address) has already been redeemed",
    "InvalidBLS":              "the BLS pairing check failed on-chain — e(S, G2) != e(Y, PK_mint). Possible causes: wrong mint keypair, corrupted S from scan, or hash-to-curve mismatch between Python and Solidity",
    "InvalidSignatureLength":  "spend signature must be exactly 65 bytes (r‖s‖v)",
    "EthSendFailed":           "ETH transfer to recipient failed (recipient may be a contract that rejects ETH)",
    "HashToCurveFailed":       "hash-to-curve did not converge within MAX_H2C_ITERS iterations",
    "NotMintAuthority":        "caller is not the registered mintAuthority address",
    "DepositNotFound":         "no pending deposit exists for this depositId",
    "DepositIdAlreadyUsed":    "a deposit with this depositId has already been registered",
    "AlreadyFulfilled":        "the mint has already announced a signature for this depositId",
    "InvalidDepositId":        "depositId must not be address(0)",
}


def decode_contract_error(error) -> str:
    """
    Decode a contract revert into a human-readable string.

    Accepts:
        - A web3 ContractCustomError or ContractLogicError exception
        - A raw hex string (e.g. "0x28739233")
        - Any exception whose str/args contain a hex selector

    Returns a string like:
        "InvalidBLS — the BLS pairing check failed on-chain"
    or:
        "Unknown contract error (0xdeadbeef)"
    """
    # Extract the hex selector from various input types
    selector_hex = _extract_selector(error)

    if selector_hex and selector_hex in _SELECTOR_TO_NAME:
        name = _SELECTOR_TO_NAME[selector_hex]
        hint = _HINTS.get(name, "")
        if hint:
            return f"{name} — {hint}"
        return name

    if selector_hex:
        return f"Unknown contract error (0x{selector_hex})"

    return f"Contract reverted: {error}"


def _extract_selector(error) -> str | None:
    """
    Pull the 4-byte selector hex (without 0x) from various representations.
    """
    # Raw hex string
    if isinstance(error, str):
        cleaned = error.strip().lower().replace("0x", "")
        if len(cleaned) >= 8 and all(c in "0123456789abcdef" for c in cleaned[:8]):
            return cleaned[:8]
        return None

    # web3 ContractCustomError: .data attribute contains the hex
    data = getattr(error, "data", None)
    if data and isinstance(data, str):
        return _extract_selector(data)

    # web3 exceptions often store data in args
    if hasattr(error, "args"):
        for arg in error.args:
            if isinstance(arg, str):
                result = _extract_selector(arg)
                if result:
                    return result

    # Last resort: str(error) might contain "0xXXXXXXXX"
    s = str(error)
    import re
    match = re.search(r"0x([0-9a-fA-F]{8,})", s)
    if match:
        return match.group(1)[:8].lower()

    return None
