## Ghost-Tip: deterministic token secrets (normative for clients)

All values below use **Keccak-256** outputs as **32-byte big-endian** integers where a scalar is needed. **`master_seed`** is the raw 32-byte seed (hex in `vectors.json` is only an example encoding).

1. **`base`** — bind seed and token slot:

   `base = keccak256(abi.encodePacked(master_seed, token_index_u32_le))`

   Use a **fixed-width little-endian `uint32`** for `token_index` (same as `new Uint32Array([tokenIndex]).buffer` in JS) so every implementation agrees.

2. **`spend_priv`** — secp256k1 private key material:

   `spend_priv = keccak256(abi.encodePacked(bytes("spend"), base))`

3. **`spend_addr`** — Ethereum address (nullifier at redeem):

   `spend_addr = pubkeyToAddress(spend_priv · G)` using the usual **uncompressed secp256k1** public key and `keccak256(pubkey[1:])`, then `uint160`.

4. **Blinding scalar `r`** (BN254 curve order `q`):

   `r = uint256(keccak256(abi.encodePacked(bytes("blind"), base))) mod q`

   This matches the common pattern **`"blind"` prefixed to the same `base`** as spend (not `seed ‖ "blind" ‖ index` unless you redefine `base` that way). **Python/TS and `vectors.json` must use the same rule** or `BLINDING_R` / `SPEND_ADDRESS` will not match.

Then off-chain: `Y = H_G1(spend_addr)`, `B = r · Y`, mint signs `B`, user unblinds to `S` for `GhostVault.redeem`.

On-chain (PoC), `H_G1` hashes **`abi.encodePacked(spend_addr)`** — **20-byte address only**. This GhostVault build has **no refund** path (trusted mint). **`forge test`** reads **`test/test-vectors/token_*.json`** by default (override with env **`GHOST_VECTOR_SUITE`**).

Regenerate those fixtures with the backend stack (**`uv`** + **`scripts/pyproject.toml`** / **`scripts/requirements.txt`** — keep dependency versions in sync):

```bash
cd scripts && uv sync && uv run generate_vectors.py
```

(`--out` defaults to repo **`test/test-vectors`**; use **`--keypairs 1`** if you want a single mint key across the whole suite instead of the last of several overwrites.)

One shot: **`bash scripts/forge_test_generated_vectors.sh`** (optional args are passed to **`generate_vectors.py`** only).

**`ghost_library`** must use the same preimages: **`hash_to_curve(spend_address_bytes)`** (20 bytes) and **`keccak256(b"Pay to: " + recipient₂₀)`** for redemption signing.

---

## Foundry

**Foundry is a blazing fast, portable and modular toolkit for Ethereum application development written in Rust.**

Foundry consists of:

- **Forge**: Ethereum testing framework (like Truffle, Hardhat and DappTools).
- **Cast**: Swiss army knife for interacting with EVM smart contracts, sending transactions and getting chain data.
- **Anvil**: Local Ethereum node, akin to Ganache, Hardhat Network.
- **Chisel**: Fast, utilitarian, and verbose solidity REPL.

## Documentation

https://book.getfoundry.sh/

## Usage

### Build

```shell
$ forge build
```

### Test

```shell
$ forge test
```

`GhostVault.t.sol` **forks Avalanche Fuji** C-Chain in `setUp` (alias `avalanche-fuji` in `foundry.toml`). Outbound RPC access is required.

| Env | Purpose |
|-----|---------|
| `FUJI_RPC_URL` | Optional. If set, used as the fork URL instead of the public Fuji endpoint from `foundry.toml`. |
| `GHOST_VECTOR_SUITE` | Optional. Directory of flat `token_*.json` files (default `test/test-vectors`). |

CLI (same RPC as tests when using the alias):

```shell
forge test --fork-url avalanche-fuji
```

### Format

```shell
$ forge fmt
```

### Gas Snapshots

```shell
$ forge snapshot
```

### Anvil

```shell
$ anvil
```

### Deploy

```shell
$ forge script script/GhostVault.s.sol:GhostVaultScript --rpc-url <your_rpc_url> --private-key <your_private_key>
```

### Cast

```shell
$ cast <subcommand>
```

### Help

```shell
$ forge --help
$ anvil --help
$ cast --help
```
