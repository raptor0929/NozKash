# 👻 Ghost-Tip Protocol

A stateless, privacy-preserving eCash system for EVM chains, built on BLS blind signatures over the BN254 curve.

Users deposit a fixed denomination (0.01 ETH), receive a cryptographically blind-signed token from an off-chain mint, and redeem it to any address — without the mint ever learning which deposit corresponds to which redemption.

This repository is a research and reference implementation containing a shared cryptographic library (Python + TypeScript with byte-for-byte parity), a mint server daemon, a CLI wallet, and a cross-language test suite.

---

## How It Works

```
Client                     GhostVault (on-chain)          Mint Server
  │                               │                            │
  │  derive spend + blind keys    │                            │
  │  Y = H(spendAddress)          │                            │
  │  B = r · Y                    │                            │
  │                               │                            │
  │── deposit(B, blindAddr) ─────▶│                            │
  │   + 0.01 ETH                  │── DepositLocked(id, B) ──▶│
  │                               │                            │  S' = sk · B
  │                               │◀── announce(id, S') ──────│
  │                               │                            │
  │  S = S' · r⁻¹  (unblind)     │                            │
  │  verify e(S,G2)==e(Y,PK)      │                            │
  │                               │                            │
  │── redeem(dest, sig, S) ──────▶│                            │
  │                               │  ecrecover → nullifier     │
  │                               │  ecPairing → BLS verify    │
  │                               │── 0.01 ETH ──────────────▶ dest
```

**Privacy:** The blinding factor `r` is known only to the client. The mint signs `B = r·Y` without ever seeing `Y` or the spend address. At redemption the contract learns the nullifier but cannot link it back to the original deposit.

**MEV protection:** The redemption includes an ECDSA signature over `"Pay to: <recipient>"`. The contract recovers the nullifier via `ecrecover` — a front-runner cannot change the recipient without invalidating the signature.

**Stateless recovery:** All secrets (spend key, blind key, blinding factor) are deterministically derived from a master seed and token index, so the wallet can be fully reconstructed from the seed alone.

---

## Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| Python | 3.13+ | Library, mint server, CLI wallet |
| Node.js | 20+ | TypeScript library, test suite |
| [uv](https://docs.astral.sh/uv/) | latest | Python package management |
| npm | bundled with Node | TypeScript package management |

---

## Quick Start

```bash
# Install dependencies
uv venv && uv sync      # Python
npm install              # TypeScript

# Generate keys and .env
uv run generate_keys.py

# Run tests
uv run pytest -v         # Python unit + vector tests
npx vitest run           # TypeScript vector parity tests
```

---

## Repository Layout

```
├── ghost_library.py          # Python cryptographic library (source of truth)
├── ghost-library.ts          # TypeScript port (byte-for-byte parity)
├── bn254-crypto.ts           # Low-level BN254 primitives (mcl-wasm)
│
├── mint_server.py            # Off-chain mint daemon
├── client.py                 # CLI wallet (deposit / scan / redeem / status)
├── generate_keys.py          # Keypair + .env generator
├── generate_vectors.py       # Cross-language test vector generator
│
├── ghost_library_test.py     # Python unit tests (20 cases)
├── test_vectors.py           # Python parametrized vector tests
├── test-vectors.test.ts      # TypeScript parametrized vector tests
├── ghost_tip_test.py         # Python end-to-end smoke test
├── test.ts                   # TypeScript end-to-end smoke test
│
├── test_vectors/             # Generated vector files
├── pyproject.toml            # Python dependencies
├── package.json              # Node dependencies
└── .env                      # Local secrets (never committed)
```

---

## Library API Reference

The Python library (`ghost_library.py`) is the source of truth. The TypeScript library (`ghost-library.ts` + `bn254-crypto.ts`) is a byte-for-byte port. Both expose the same logical operations with language-appropriate conventions.

### Types

| Concept | Python | TypeScript |
|---------|--------|------------|
| BN254 G1 point | `G1Point` — `tuple[FQ, FQ]` | `mcl.G1` |
| BN254 G2 point | `G2Point` — `tuple[FQ2, FQ2]` | `mcl.G2` |
| Field scalar | `Scalar` — `int` | `bigint` |
| Keypair | `TokenKeypair` dataclass | `TokenKeypair` interface |
| Both keypairs | `TokenSecrets` dataclass | `TokenSecrets` interface |
| Blinded pair | `BlindedPoints` dataclass | `BlindedPoints` interface |
| ECDSA proof | `RedemptionProof` dataclass | `RedemptionProof` interface |
| Mint keys | `MintKeypair` dataclass | `MintKeypair` interface |

### `TokenKeypair`

A secp256k1 keypair derived deterministically from the master seed. Both the spend and blind keypairs share this structure.

| Field | Python | TypeScript | Description |
|-------|--------|------------|-------------|
| Private key | `priv: keys.PrivateKey` | `priv: Uint8Array` | 32-byte private key |
| Public key | `pub_hex: str` | `pubHex: string` | `0x04`-prefixed uncompressed key (65 bytes) |
| Address | `address: str` | `address: string` | `0x`-prefixed Ethereum address |
| Address bytes | `address_bytes: bytes` | `addressBytes: Uint8Array` | Raw 20 bytes |

### `TokenSecrets`

Client-side only — neither private key must reach the mint.

| Field | Python | TypeScript | Description |
|-------|--------|------------|-------------|
| Spend keypair | `spend: TokenKeypair` | `spend: TokenKeypair` | Nullifier identity |
| Blind keypair | `blind: TokenKeypair` | `blind: TokenKeypair` | Deposit ID + blinding source |

Convenience properties / accessors:

| Property | Python | TypeScript | Returns |
|----------|--------|------------|---------|
| Spend private key | `secrets.spend_priv` | `getSpendPriv(secrets)` | Spend private key |
| Spend address | `secrets.spend_address_hex` | `getSpendAddress(secrets)` | Nullifier address |
| Spend address bytes | `secrets.spend_address_bytes` | `getSpendAddressBytes(secrets)` | Raw 20 bytes |
| Deposit ID | `secrets.deposit_id` | `getDepositId(secrets)` | Blind keypair address |
| Blinding factor | `secrets.r` | `getR(secrets)` | `int(blind_priv) % curve_order` |

### Error Hierarchy

Both libraries define a matching exception/error tree:

```
GhostError
├── CurveError              (Python only)
│   ├── InvalidPointError   (Python only — carries .x, .y, .curve)
│   └── ScalarMultiplicationError  (Python only)
├── DerivationError         (bad seed, negative index, index > 2³²)
└── VerificationError       (malformed compact_hex, invalid recovery_bit)
```

TypeScript omits `CurveError` and its children since `mcl-wasm` handles point validation internally.

---

### Setup

#### `generateMintKeypair`

Generates a random BLS keypair for the mint.

```python
# Python
from ghost_library import generate_mint_keypair
keypair = generate_mint_keypair()
# keypair.sk: Scalar, keypair.pk: G2Point
```

```typescript
// TypeScript — must call initBN254() first
import { initBN254 } from './bn254-crypto.js';
import { generateMintKeypair } from './ghost-library.js';
await initBN254();
const { skMint, pkMint } = generateMintKeypair();
```

---

### Client Operations

#### `deriveTokenSecrets`

Deterministically derives both token keypairs (spend + blind) for a given index from the master seed. All wallet secrets are recoverable from just the seed.

| Parameter | Python | TypeScript | Constraints |
|-----------|--------|------------|-------------|
| Master seed | `master_seed: bytes` | `masterSeed: Uint8Array` | Non-empty |
| Token index | `token_index: int` | `tokenIndex: number` | 0 ≤ n ≤ 2³² − 1 |

```python
# Python
secrets = derive_token_secrets(b"my_seed", token_index=0)
secrets.spend.address      # nullifier
secrets.deposit_id         # deposit ID (blind address)
secrets.r                  # blinding scalar
```

```typescript
// TypeScript
const secrets = deriveTokenSecrets(seed, 0);
getSpendAddress(secrets)   // nullifier
getDepositId(secrets)      // deposit ID
getR(secrets)              // blinding scalar (bigint)
```

**Throws** `DerivationError` for empty seed, negative index, or index ≥ 2³².

#### `blindToken`

Maps the spend address to a BN254 G1 point and applies multiplicative blinding.

| Parameter | Type (Py / TS) | Description |
|-----------|----------------|-------------|
| `spend_address_bytes` | `bytes` / `Uint8Array` | Raw 20-byte spend address |
| `r` | `Scalar` / `bigint` | Blinding factor from `TokenSecrets` |

**Returns** `BlindedPoints { Y, B }` where `Y = H(address)` and `B = r·Y`. Only `B` is sent to the mint.

```python
blinded = blind_token(secrets.spend_address_bytes, secrets.r)
# blinded.Y — keep private; blinded.B — send to contract
```

```typescript
const { Y, B } = blindToken(getSpendAddressBytes(secrets), getR(secrets));
```

#### `unblindSignature`

Removes the blinding factor from the mint's signature: `S = S' · r⁻¹`.

```python
S = unblind_signature(S_prime, secrets.r)
```

```typescript
const S = unblindSignature(S_prime, getR(secrets));
```

#### `generateRedemptionProof`

Creates the anti-MEV ECDSA signature binding the token to a destination address. The contract calls `ecrecover` on this to derive the nullifier.

| Parameter | Type | Description |
|-----------|------|-------------|
| `spend_priv` | `PrivateKey` / `Uint8Array` | Spend private key |
| `destination_address` | `str` / `string` | Recipient `0x` address |

**Returns** `RedemptionProof` with `msg_hash`, `compact_hex` (128-char r‖s), `recovery_bit` (0 or 1).

```python
proof = generate_redemption_proof(secrets.spend_priv, "0xRecipient...")
# proof.compact_hex — 128 hex chars (r || s)
# proof.recovery_bit — 0 or 1; EVM uses v = bit + 27
```

```typescript
const proof = await generateRedemptionProof(secrets.spend.priv, "0xRecipient...");
// proof.compactHex, proof.recoveryBit
```

> **Note:** The TypeScript version is `async` because `@noble/curves` v2.x sign may be async.

---

### Mint Operations

#### `mintBlindSign`

Core mint operation: `S' = sk · B`. The mint never sees the spend address — only the blinded point.

```python
S_prime = mint_blind_sign(blinded.B, keypair.sk)
```

```typescript
const S_prime = mintBlindSign(B, skMint);
```

**Throws** `InvalidPointError` (Python) if `B` is not on the BN254 G1 curve.

---

### Verification

#### `verifyBlsPairing`

Checks the BLS pairing equation: `e(S, G2) == e(Y, PK_mint)`. This is the mathematical statement the on-chain `ecPairing` precompile verifies.

```python
assert verify_bls_pairing(S, blinded.Y, keypair.pk)
```

```typescript
expect(verifyBlsPairing(S, Y, pkMint)).toBe(true);
```

#### `verifyEcdsaMevProtection`

Simulates the EVM `ecrecover` precompile. Recovers the signer address from the ECDSA proof and checks it matches the expected nullifier.

```python
assert verify_ecdsa_mev_protection(
    proof.msg_hash, proof.compact_hex, proof.recovery_bit, secrets.spend_address_hex
)
```

```typescript
expect(verifyEcdsaMevProtection(proof, getSpendAddress(secrets))).toBe(true);
```

**Throws** `VerificationError` for malformed inputs (wrong hex length, invalid recovery bit). Returns `false` for cryptographically invalid signatures.

---

### Point Utilities (Python only)

| Function | Signature | Description |
|----------|-----------|-------------|
| `hash_to_curve` | `(message_bytes: bytes) → G1Point` | Try-and-increment hash to BN254 G1 |
| `serialize_g1` | `(point: G1Point) → tuple[int, int]` | Extract (x, y) as integers for Solidity |
| `parse_g1` | `(x: int, y: int) → G1Point` | Reconstruct from integers; raises `InvalidPointError` if off-curve |

### BN254 Primitives (TypeScript only — `bn254-crypto.ts`)

| Function | Signature | Description |
|----------|-----------|-------------|
| `initBN254` | `() → Promise<void>` | Load mcl-wasm; call once at startup |
| `hashToCurveBN254` | `(messageBytes: Uint8Array) → mcl.G1` | Try-and-increment (matches Python) |
| `multiplyBN254` | `(point: mcl.G1, scalar: bigint) → mcl.G1` | G1 scalar multiplication |
| `verifyPairingBN254` | `(S, Y, PK_mint) → boolean` | BLS pairing check |
| `formatG1ForSolidity` | `(point: mcl.G1) → [string, string]` | Base-10 strings for ethers/viem |
| `modularInverse` | `(k: bigint, mod: bigint) → bigint` | Fermat's little theorem |

Constants: `FIELD_MODULUS`, `CURVE_ORDER`.

---

## Full Lifecycle Example

```python
from ghost_library import *

# Setup
keypair = generate_mint_keypair()
secrets = derive_token_secrets(b"my_seed", token_index=0)

# Client blinds
blinded = blind_token(secrets.spend_address_bytes, secrets.r)

# Mint signs (only B crosses the trust boundary)
S_prime = mint_blind_sign(blinded.B, keypair.sk)

# Client unblinds
S = unblind_signature(S_prime, secrets.r)

# Generate redemption proof
proof = generate_redemption_proof(secrets.spend_priv, "0xRecipient...")

# Verify
assert verify_bls_pairing(S, blinded.Y, keypair.pk)
assert verify_ecdsa_mev_protection(
    proof.msg_hash, proof.compact_hex, proof.recovery_bit, secrets.spend_address_hex
)
```

---

## CLI Wallet (`client.py`)

Each command prints every intermediate cryptographic value for debugging.

```bash
uv run client.py deposit --index 0              # Lock 0.01 ETH + blinded point
uv run client.py scan --from-block 7500000       # Recover signed tokens
uv run client.py redeem --index 0 --to 0xAddr    # Redeem to any address
uv run client.py redeem --index 0 --to 0xAddr --relayer http://localhost:8000
uv run client.py status                          # Token lifecycle summary
uv run client.py balance                         # On-chain ETH balance
```

Token lifecycle: `FRESH` → `AWAITING_MINT` → `READY_TO_REDEEM` → `SPENT`

Wallet state is cached in `.ghost_wallet.json` but is fully recoverable from the seed via `scan`.

---

## Mint Server (`mint_server.py`)

Stateless async daemon. Connects over WebSocket, polls for `DepositLocked` events, computes `S' = sk·B`, and calls `announce()`.

```bash
uv run mint_server.py                        # Normal output
uv run mint_server.py --verbosity verbose    # Show intermediate crypto values
uv run mint_server.py --verbosity debug      # Full raw event data
```

Validates submitted G1 points before signing — off-curve points are rejected with a warning rather than wasting gas.

---

## Environment Variables

### Shared

| Variable | Used by | Description |
|----------|---------|-------------|
| `MASTER_SEED` | client | Hex seed — all wallet secrets derive from this |
| `MINT_BLS_PRIVKEY` | mint | Hex BLS scalar for blind signing |
| `CONTRACT_ADDRESS` | both | Deployed GhostVault address |

### Mint server

| Variable | Default | Description |
|----------|---------|-------------|
| `RPC_WS_URL` | — | WebSocket RPC endpoint |
| `MINT_WALLET_ADDRESS` | — | Gas-paying address |
| `MINT_WALLET_KEY` | — | Private key for above |
| `POLL_INTERVAL_SECONDS` | `2` | Event polling interval |

### CLI wallet

| Variable | Default | Description |
|----------|---------|-------------|
| `WALLET_ADDRESS` | — | Gas-paying address |
| `WALLET_KEY` | — | Private key for above |
| `RPC_HTTP_URL` | — | HTTP RPC endpoint |
| `SCAN_FROM_BLOCK` | `0` | Starting block for scans |

---

## Testing

### Python unit tests

```bash
uv run pytest ghost_library_test.py -v    # 20 tests
```

Covers the full exception hierarchy, determinism, index-256 boundary (catches the `Uint8Array` truncation bug), point validation, MEV protection edge cases, and cross-keypair BLS rejection.

### Cross-language vector tests

Both suites load the same JSON vectors and run identical assertions, proving byte-for-byte cryptographic parity.

```bash
uv run pytest test_vectors.py -v    # Python
npx vitest run                      # TypeScript
```

Each vector is tested for: G2 key derivation, token secret derivation, hash-to-curve + blinding, blind signature, unblinding, MEV proof, and full BLS pairing.

### Generating vectors

```bash
uv run generate_vectors.py                                    # 3 keypairs × 6 indices
uv run generate_vectors.py --keypairs 10 --indices 0 256 1000 # Custom
```

Index 256 is always included to exercise the `DataView` fix.

### End-to-end smoke tests

```bash
uv run ghost_tip_test.py    # Python
npx tsx test.ts              # TypeScript
```

Both print identical intermediate values when given the same `.env` secrets.

---

## Cryptographic Design Notes

**Curve:** BN254 (`alt_bn128`) — the only pairing-friendly curve with native EVM precompile support (`ecAdd` 0x06, `ecMul` 0x07, `ecPairing` 0x08). ECDSA uses secp256k1 via the existing `ecrecover` opcode.

**Hash-to-curve:** Try-and-increment with `keccak256(message ‖ counter_be32)`. The square root uses `y = (y²)^((p+1)/4) mod p` (valid because `p ≡ 3 mod 4`). Python and TypeScript use identical byte encoding.

**Blinding:** Multiplicative in Z_q. The algebraic identity `S = S'·r⁻¹ = sk·r·Y·r⁻¹ = sk·Y` ensures `e(S, G2) = e(Y, sk·G2) = e(Y, PK_mint)`.

**Token index encoding:** 4-byte big-endian via `DataView.setUint32` (TS) / `int.to_bytes(4, 'big')` (Python). The `Uint8Array` constructor pattern was avoided because it silently truncates values ≥ 256.

**Recovery bit:** The TypeScript library derives the ECDSA recovery bit mathematically via trial recovery — it never reads a `.recovery` property that might default to 0 in older library versions.

---

## Sepolia Testnet Walkthrough

```bash
# 1. Generate secrets
uv run generate_keys.py

# 2. Configure .env with CONTRACT_ADDRESS, RPC URLs, wallet keys

# 3. Start mint (separate terminal)
uv run mint_server.py

# 4. Deposit
uv run client.py deposit --index 0
# → mint picks up DepositLocked, calls announce()

# 5. Scan and recover
uv run client.py scan --from-block <block> --index-from 0 --index-to 0

# 6. Redeem
uv run client.py redeem --index 0 --to 0xRecipient

# 7. Verify
uv run pytest -v && npx vitest run
```
