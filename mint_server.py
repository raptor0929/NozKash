"""
Ghost-Tip Protocol: Mint Server

Stateless daemon that listens for GhostVault DepositLocked events, performs
the blind BLS signing operation (S' = sk * B), and broadcasts the blinded
signature back to the contract via the announce() function.

Configuration (via .env or environment variables):
    MINT_BLS_PRIVKEY        Hex scalar private key (from generate_keys.py)
    CONTRACT_ADDRESS        Deployed GhostVault contract address
    RPC_WS_URL              WebSocket RPC endpoint (e.g. wss://sepolia.infura.io/...)
    MINT_WALLET_ADDRESS     Ethereum address that pays for announce() gas
    MINT_WALLET_KEY         Private key for the above address (hex, no 0x prefix)
    POLL_INTERVAL_SECONDS   Event polling interval (default: 2)
    LOG_LEVEL               Logging level (default: INFO)

Usage:
    uv run mint_server.py
"""

import asyncio
import logging
import os
import sys
from dataclasses import dataclass

import typer
from dotenv import load_dotenv
from web3 import AsyncWeb3, WebSocketProvider
from web3.types import EventData

from ghost_library import (
    G1Point, Scalar,
    parse_g1, serialize_g1, mint_blind_sign,
    GhostError, InvalidPointError, CurveError,
)

load_dotenv()

# ==============================================================================
# CONFIGURATION
# ==============================================================================

@dataclass(frozen=True)
class MintConfig:
    sk:                  Scalar
    contract_address:    str
    rpc_ws_url:          str
    wallet_address:      str
    wallet_key:          str
    poll_interval:       float
    log_level:           str


def load_config() -> MintConfig:
    """
    Loads and validates all required configuration from the environment.
    Raises SystemExit with a clear message if anything is missing or malformed.
    """
    missing = []

    def require(key: str) -> str:
        val = os.getenv(key, "").strip()
        if not val:
            missing.append(key)
        return val

    sk_hex          = require("MINT_BLS_PRIVKEY")
    contract_addr   = require("CONTRACT_ADDRESS")
    rpc_ws_url      = require("RPC_WS_URL")
    wallet_address  = require("MINT_WALLET_ADDRESS")
    wallet_key      = require("MINT_WALLET_KEY")

    if missing:
        print(f"[mint_server] Missing required environment variables: {', '.join(missing)}", file=sys.stderr)
        print("  Run generate_keys.py to create a .env file, then set CONTRACT_ADDRESS,", file=sys.stderr)
        print("  RPC_WS_URL, MINT_WALLET_ADDRESS, and MINT_WALLET_KEY.", file=sys.stderr)
        sys.exit(1)

    try:
        sk = Scalar(int(sk_hex, 16))
    except ValueError:
        print(f"[mint_server] MINT_BLS_PRIVKEY is not valid hex: {sk_hex[:16]}...", file=sys.stderr)
        sys.exit(1)

    return MintConfig(
        sk=sk,
        contract_address=contract_addr,
        rpc_ws_url=rpc_ws_url,
        wallet_address=wallet_address,
        wallet_key=wallet_key if wallet_key.startswith("0x") else "0x" + wallet_key,
        poll_interval=float(os.getenv("POLL_INTERVAL_SECONDS", "2")),
        log_level=os.getenv("LOG_LEVEL", "INFO").upper(),
    )


# ==============================================================================
# CONTRACT ABI (minimal — only the events and functions we need)
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
        "name": "announce",
        "type": "function",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "depositId",        "type": "address"},
            {"name": "blindedSignature", "type": "uint256[2]"},
        ],
        "outputs": [],
    },
]


# ==============================================================================
# SIGNING LOGIC
# ==============================================================================

def sign_deposit(blinded_point_raw: list[int], sk: Scalar) -> tuple[int, int]:
    """
    Core mint operation: validates the client's blinded G1 point and signs it.

    Args:
        blinded_point_raw: [x, y] as uint256 integers from the contract event.
        sk:                Mint's BLS scalar private key.

    Returns:
        (x, y) coordinates of S' = sk * B as uint256 integers for Solidity.

    Raises:
        InvalidPointError: if the submitted point is not on the BN254 G1 curve.
    """
    B = parse_g1(int(blinded_point_raw[0]), int(blinded_point_raw[1]))
    S_prime = mint_blind_sign(B, sk)
    return serialize_g1(S_prime)


# ==============================================================================
# MINT DAEMON
# ==============================================================================

class MintDaemon:
    """
    Connects to the GhostVault contract over WebSocket, polls for DepositLocked
    events, and broadcasts the blind signature via announce().
    """

    def __init__(self, config: MintConfig) -> None:
        self.config = config
        self.log = logging.getLogger("mint_server")

    async def run(self) -> None:
        """Main entry point. Reconnects automatically on connection loss."""
        self.log.info("Ghost-Tip Mint Server starting")
        self.log.info("Contract : %s", self.config.contract_address)
        self.log.info("Wallet   : %s", self.config.wallet_address)

        while True:
            try:
                await self._connect_and_listen()
            except Exception as exc:
                self.log.error("Connection error: %s — reconnecting in 5s", exc)
                await asyncio.sleep(5)

    async def _connect_and_listen(self) -> None:
        self.log.info("Connecting to %s", self.config.rpc_ws_url)

        async with AsyncWeb3(WebSocketProvider(self.config.rpc_ws_url)) as w3:
            if not await w3.is_connected():
                raise ConnectionError("WebSocket connection failed")

            chain_id = await w3.eth.chain_id
            self.log.info("Connected — chain_id=%d", chain_id)

            contract = w3.eth.contract(
                address=AsyncWeb3.to_checksum_address(self.config.contract_address),
                abi=GHOST_VAULT_ABI,
            )

            event_filter = await contract.events.DepositLocked.create_filter(
                from_block="latest"
            )
            self.log.info("Listening for DepositLocked events...")

            while True:
                entries: list[EventData] = await event_filter.get_new_entries()
                for event in entries:
                    await self._handle_deposit(w3, contract, event)
                await asyncio.sleep(self.config.poll_interval)

    async def _handle_deposit(
        self,
        w3: AsyncWeb3,
        contract,
        event: EventData,
    ) -> None:
        deposit_id = event["args"]["depositId"]
        b_coords   = event["args"]["B"]
        tx_hash    = event["transactionHash"].hex()

        self.log.info(
            "DepositLocked  depositId=%s  tx=%s", deposit_id, tx_hash[:18] + "..."
        )

        # 1. Perform the blind signing
        try:
            s_prime_x, s_prime_y = sign_deposit(b_coords, self.config.sk)
        except InvalidPointError as exc:
            self.log.warning(
                "Rejected depositId=%s — invalid G1 point: %s", deposit_id, exc
            )
            return
        except GhostError as exc:
            self.log.error(
                "Signing failed for depositId=%s: %s", deposit_id, exc
            )
            return

        self.log.info(
            "Signed         S'.x=0x%x...  S'.y=0x%x...",
            s_prime_x >> 240, s_prime_y >> 240,
        )

        # 2. Submit the announce() transaction
        try:
            await self._submit_announcement(w3, contract, deposit_id, [s_prime_x, s_prime_y])
        except Exception as exc:
            self.log.error(
                "announce() failed for depositId=%s: %s", deposit_id, exc
            )

    async def _submit_announcement(
        self,
        w3: AsyncWeb3,
        contract,
        deposit_id: int,
        s_prime_coords: list[int],
    ) -> None:
        wallet = AsyncWeb3.to_checksum_address(self.config.wallet_address)
        nonce  = await w3.eth.get_transaction_count(wallet)
        gas_price = await w3.eth.gas_price

        tx = await contract.functions.announce(
            deposit_id,
            s_prime_coords,
        ).build_transaction({
            "from":     wallet,
            "nonce":    nonce,
            "gasPrice": gas_price,
        })

        signed = w3.eth.account.sign_transaction(tx, private_key=self.config.wallet_key)
        tx_hash = await w3.eth.send_raw_transaction(signed.raw_transaction)

        self.log.info(
            "announce() sent  depositId=%s  tx=%s",
            deposit_id, tx_hash.hex()[:18] + "...",
        )

        # Wait for one confirmation
        receipt = await w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
        if receipt["status"] == 1:
            self.log.info(
                "Confirmed        depositId=%s  block=%d",
                deposit_id, receipt["blockNumber"],
            )
        else:
            self.log.error(
                "Reverted         depositId=%s  tx=%s",
                deposit_id, tx_hash.hex(),
            )


# ==============================================================================
# TYPER APP
# ==============================================================================

app = typer.Typer(
    name="mint-server",
    help="Ghost-Tip Protocol Mint Server — listens for deposits and issues blind signatures.",
    add_completion=False,
)


@app.command()
def run(
    log_level: str = typer.Option(
        None,
        "--log-level",
        help="Logging level (DEBUG, INFO, WARNING, ERROR). Overrides LOG_LEVEL env var.",
        metavar="LEVEL",
    ),
) -> None:
    """Start the mint daemon. Connects over WebSocket and processes DepositLocked events."""
    config = load_config()

    effective_level = (log_level or config.log_level).upper()
    logging.basicConfig(
        level=getattr(logging, effective_level, logging.INFO),
        format="%(asctime)s  %(levelname)-8s  %(name)s  %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S",
    )

    daemon = MintDaemon(config)
    asyncio.run(daemon.run())


if __name__ == "__main__":
    app()
