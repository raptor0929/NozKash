/**
 * Ghost-Tip Protocol: TypeScript CLI Client
 *
 * TypeScript equivalent of client.py. Interacts with the deployed GhostVault
 * contract on Sepolia using viem for chain interaction.
 *
 * Commands:
 *   deposit   Blind a token and submit a deposit transaction
 *   scan      Scan chain events to find and recover pending/spendable tokens
 *   redeem    Unblind a recovered token and redeem it on-chain
 *   balance   Query on-chain ETH balance
 *
 * Usage:
 *   npx tsx client.ts deposit --index 0
 *   npx tsx client.ts scan
 *   npx tsx client.ts redeem --index 0 --to 0xRecipient
 *   npx tsx client.ts balance
 */

import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import {
    createPublicClient, createWalletClient, http, parseEther, formatEther, formatGwei,
    getAddress, defineChain, type Hex, type Address, type PublicClient, type WalletClient, type Chain,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import mcl from 'mcl-wasm';
import { initBN254, getG2Generator, CURVE_ORDER, formatG1ForSolidity } from './bn254-crypto.js';
import * as gl from './ghost-library.js';

// ==============================================================================
// CONFIG
// ==============================================================================

const DENOMINATION = parseEther('0.001');
const WALLET_STATE_FILE = resolve('.ghost_wallet.json');
const ABI_PATH = resolve('sol/ghost_vault_abi.json');

interface Config {
    masterSeed:      Uint8Array;
    walletKey:       Hex;
    walletAddress:   Address;
    contractAddress: Address;
    rpcUrl:          string;
    scanFromBlock:   bigint;
    mintBlsPubkey:   mcl.G2 | null;
}

function loadConfig(): Config {
    const seed = process.env.MASTER_SEED;
    if (!seed) throw new Error('Missing MASTER_SEED in .env');

    const walletKey = process.env.WALLET_KEY;
    const walletAddr = process.env.WALLET_ADDRESS;
    const contract = process.env.CONTRACT_ADDRESS;
    const rpc = process.env.RPC_HTTP_URL;

    if (!walletKey || !walletAddr || !contract || !rpc) {
        throw new Error('Missing WALLET_KEY, WALLET_ADDRESS, CONTRACT_ADDRESS, or RPC_HTTP_URL in .env');
    }

    // Parse mint BLS pubkey if available
    let mintBlsPubkey: mcl.G2 | null = null;
    const pkStr = process.env.MINT_BLS_PUBKEY || '';
    if (pkStr) {
        const parts = pkStr.split(',').map(p => p.trim());
        if (parts.length === 4) {
            const pk = new mcl.G2();
            // EIP-197 order in env: X_imag, X_real, Y_imag, Y_real
            // mcl setStr: "1 X_real X_imag Y_real Y_imag"
            pk.setStr(`1 ${parts[1]} ${parts[0]} ${parts[3]} ${parts[2]}`, 16);
            mintBlsPubkey = pk;
        }
    }
    // Fallback: derive from privkey
    if (!mintBlsPubkey) {
        const skHex = process.env.MINT_BLS_PRIVKEY || process.env.MINT_BLS_PRIVKEY_INT || '';
        if (skHex) {
            const sk = BigInt(skHex.startsWith('0x') ? skHex : `0x${skHex}`) % CURVE_ORDER;
            const g2 = getG2Generator();
            const fr = new mcl.Fr();
            fr.setStr(sk.toString(16), 16);
            mintBlsPubkey = mcl.mul(g2, fr) as mcl.G2;
        }
    }

    const key = walletKey.startsWith('0x') ? walletKey as Hex : `0x${walletKey}` as Hex;

    return {
        masterSeed:      Buffer.from(seed, 'utf-8'),
        walletKey:       key,
        walletAddress:   getAddress(walletAddr),
        contractAddress: getAddress(contract),
        rpcUrl:          rpc,
        scanFromBlock:   BigInt(process.env.SCAN_FROM_BLOCK || '0'),
        mintBlsPubkey,
    };
}

// ==============================================================================
// WALLET STATE
// ==============================================================================

interface TokenRecord {
    index:          number;
    spend_address:  string;
    deposit_id:     string;
    deposit_tx:     string | null;
    deposit_block:  number | null;
    s_unblinded_x:  string | null;
    s_unblinded_y:  string | null;
    redeem_tx:      string | null;
    spent:          boolean;
}

interface WalletState {
    tokens:             Record<string, TokenRecord>;
    last_scanned_block: number;
}

function loadWalletState(): WalletState {
    if (!existsSync(WALLET_STATE_FILE)) {
        return { tokens: {}, last_scanned_block: 0 };
    }
    return JSON.parse(readFileSync(WALLET_STATE_FILE, 'utf-8'));
}

function saveWalletState(state: WalletState): void {
    writeFileSync(WALLET_STATE_FILE, JSON.stringify(state, null, 2));
}

function tokenStatus(rec: TokenRecord): string {
    if (rec.spent) return 'SPENT';
    if (rec.s_unblinded_x) return 'READY_TO_REDEEM';
    if (rec.deposit_tx) return 'AWAITING_MINT';
    return 'FRESH';
}

// ==============================================================================
// CONTRACT ABI
// ==============================================================================

const GHOST_VAULT_ABI = JSON.parse(readFileSync(ABI_PATH, 'utf-8'));

// ==============================================================================
// HELPERS
// ==============================================================================

function log(msg: string)  { console.log(`  ${msg}`); }
function ok(msg: string)   { console.log(`  ✅  ${msg}`); }
function err(msg: string)  { console.log(`  ❌  ${msg}`); }
function kv(k: string, v: string) { console.log(`    ${k.padEnd(24)} ${v}`); }
function section(title: string) { console.log(`\n──── ${title} ────`); }
function shortHex(hex: string, head = 18, tail = 8): string {
    if (hex.length <= head + tail + 3) return hex;
    return `${hex.slice(0, head)}…${hex.slice(-tail)}`;
}

function encodeSpendSignature(compactHex: string, recoveryBit: number): Hex {
    const r = compactHex.slice(0, 64);
    const s = compactHex.slice(64);
    const v = (recoveryBit + 27).toString(16).padStart(2, '0');
    return `0x${r}${s}${v}`;
}

async function buildClients(config: Config) {
    const account = privateKeyToAccount(config.walletKey);
    const transport = http(config.rpcUrl);

    // First create a minimal public client to detect the chain ID
    const tempClient = createPublicClient({ transport });
    const chainId = await tempClient.getChainId();

    const chain = defineChain({
        id: chainId,
        name: `Chain ${chainId}`,
        nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
        rpcUrls: { default: { http: [config.rpcUrl] } },
    });

    console.log(`  [chain] Connected to chain ID ${chainId} via ${config.rpcUrl}`);

    const publicClient = createPublicClient({ chain, transport });
    const walletClient = createWalletClient({ account, chain, transport });

    return { publicClient, walletClient, account };
}

// Format G1 point coords as [bigint, bigint] for contract calls
function g1ToBigInts(point: mcl.G1): [bigint, bigint] {
    const parts = point.getStr(16).split(' ');
    return [BigInt('0x' + parts[1]), BigInt('0x' + parts[2])];
}

// ==============================================================================
// COMMAND: deposit
// ==============================================================================

async function cmdDeposit(config: Config, tokenIndex: number) {
    console.log(`\n👻  GHOST-TIP TS CLIENT  👻\n`);
    section(`📥  DEPOSIT · Token #${tokenIndex}`);

    const state = loadWalletState();

    // Step 1: derive
    section('🔑  Step 1 · Derive Token Secrets');
    const secrets = gl.deriveTokenSecrets(config.masterSeed, tokenIndex);
    const r = gl.getR(secrets);

    kv('Token index', String(tokenIndex));
    kv('Spend address', gl.getSpendAddress(secrets));
    kv('Deposit ID', gl.getDepositId(secrets));
    log('Spend address = nullifier (revealed only at redemption)');

    // Step 2: blind
    section('🎭  Step 2 · Blind Token → G1');
    const blinded = gl.blindToken(gl.getSpendAddressBytes(secrets), r);
    const [bx, by] = g1ToBigInts(blinded.B);

    kv('B.x', shortHex(`0x${bx.toString(16)}`));
    kv('B.y', shortHex(`0x${by.toString(16)}`));
    kv('Deposit ID', gl.getDepositId(secrets));

    // Step 3: build and send deposit tx
    section('📋  Step 3 · Build deposit() Transaction');
    const { publicClient, walletClient, account } = await buildClients(config);
    const depositId = getAddress(gl.getDepositId(secrets));

    const balance = await publicClient.getBalance({ address: config.walletAddress });
    kv('Wallet address', config.walletAddress);
    kv('Balance', `${formatEther(balance)} ETH`);
    kv('Deposit amount', '0.001 ETH');

    if (balance < DENOMINATION) {
        err('Insufficient balance: need at least 0.001 ETH');
        process.exit(1);
    }

    section('📡  Step 4 · Broadcast');
    try {
        // ── DEBUG: dump exact args before contract call ──────────────────
        console.log('\n=== DEPOSIT DEBUG ===');
        console.log('[contractAddress]:', config.contractAddress);
        console.log('[depositId]:', depositId, typeof depositId);
        console.log('[bx]:', bx, typeof bx);
        console.log('[by]:', by, typeof by);
        console.log('[bx hex]:', `0x${bx.toString(16)}`);
        console.log('[by hex]:', `0x${by.toString(16)}`);
        console.log('[value]:', DENOMINATION, typeof DENOMINATION);
        console.log('[args as passed]:', JSON.stringify([depositId, [bx.toString(), by.toString()]], null, 2));

        // Check ABI deposit function
        const depositAbi = GHOST_VAULT_ABI.find((e: any) => e.name === 'deposit' && e.type === 'function');
        console.log('[ABI deposit]:', JSON.stringify(depositAbi, null, 2));
        console.log('=== END DEPOSIT DEBUG ===\n');

        const hash = await walletClient.writeContract({
            address: config.contractAddress,
            abi: GHOST_VAULT_ABI,
            functionName: 'deposit',
            args: [depositId, [bx, by]],
            value: DENOMINATION,
        });

        kv('Transaction sent', hash);
        log('Waiting for confirmation…');

        const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
        if (receipt.status !== 'success') {
            err(`Transaction REVERTED tx=${hash}`);
            process.exit(1);
        }

        kv('Confirmed block', String(receipt.blockNumber));
        kv('Gas used', String(receipt.gasUsed));
        kv('Deposit ID', depositId);

        state.tokens[String(tokenIndex)] = {
            index: tokenIndex,
            spend_address: gl.getSpendAddress(secrets),
            deposit_id: gl.getDepositId(secrets),
            deposit_tx: hash,
            deposit_block: Number(receipt.blockNumber),
            s_unblinded_x: null,
            s_unblinded_y: null,
            redeem_tx: null,
            spent: false,
        };
        saveWalletState(state);
        ok('Deposit complete. Next: run scan to recover the signed token.');

    } catch (e: any) {
        console.log('\n=== DEPOSIT ERROR DEBUG ===');
        console.log('[error type]:', e.constructor?.name);
        console.log('[error message]:', e.message?.slice(0, 500));
        console.log('[error shortMessage]:', e.shortMessage);
        console.log('[error details]:', e.details);
        console.log('[error cause]:', e.cause?.message || e.cause);
        if (e.metaMessages) console.log('[error metaMessages]:', e.metaMessages);
        console.log('=== END DEPOSIT ERROR DEBUG ===\n');
        err(`Contract error: ${e.shortMessage || e.message}`);
        process.exit(1);
    }
}
// ==============================================================================

async function cmdScan(config: Config, indexFrom: number, indexTo: number) {
    console.log(`\n👻  GHOST-TIP TS CLIENT  👻\n`);
    section(`🔍  SCAN · Tokens ${indexFrom}–${indexTo}`);

    const state = loadWalletState();
    const { publicClient } = await buildClients(config);

    const startBlock = BigInt(state.last_scanned_block) || config.scanFromBlock;
    const latestBlock = await publicClient.getBlockNumber();

    kv('Scanning blocks', `${startBlock} → ${latestBlock}`);
    kv('Token indices', `${indexFrom} – ${indexTo}`);

    // Step 1: fetch MintFulfilled events
    section('📡  Step 1 · Fetch MintFulfilled Events');
    const logs = await publicClient.getContractEvents({
        address: config.contractAddress,
        abi: GHOST_VAULT_ABI,
        eventName: 'MintFulfilled',
        fromBlock: startBlock,
        toBlock: latestBlock,
    });
    kv('Events found', String(logs.length));

    const fulfilled = new Map<string, [bigint, bigint]>();
    for (const log of logs) {
        const args = log.args as any;
        const did = getAddress(args.depositId);
        fulfilled.set(did, [BigInt(args.S_prime[0]), BigInt(args.S_prime[1])]);
    }

    // Step 2: match tokens
    section('🔗  Step 2 · Match Tokens by Deposit ID');
    let recovered = 0;

    for (let idx = indexFrom; idx <= indexTo; idx++) {
        const existing = state.tokens[String(idx)];
        const secrets = gl.deriveTokenSecrets(config.masterSeed, idx);
        const depositId = getAddress(gl.getDepositId(secrets));

        // Ensure record exists
        if (!existing) {
            state.tokens[String(idx)] = {
                index: idx,
                spend_address: gl.getSpendAddress(secrets),
                deposit_id: gl.getDepositId(secrets),
                deposit_tx: null, deposit_block: null,
                s_unblinded_x: null, s_unblinded_y: null,
                redeem_tx: null, spent: false,
            };
        }

        const rec = state.tokens[String(idx)];
        const status = tokenStatus(rec);

        // Skip FRESH tokens
        if (status === 'FRESH') continue;

        // Show cached / spent
        if (status === 'SPENT') {
            log(`\n  Token ${idx}  ·  SPENT`);
            continue;
        }
        if (status === 'READY_TO_REDEEM') {
            log(`\n  Token ${idx}  ·  READY_TO_REDEEM  (cached)`);
            continue;
        }

        // AWAITING_MINT
        log(`\n  Token ${idx}  ·  AWAITING_MINT`);

        if (!fulfilled.has(depositId)) {
            log(`    No MintFulfilled yet for ${shortHex(depositId)}`);
            continue;
        }

        const [spX, spY] = fulfilled.get(depositId)!;
        log('    Unblinding: S = S\' · r⁻¹ mod q …');

        // Load S' as mcl.G1
        const sPrime = new mcl.G1();
        sPrime.setStr(`1 ${spX.toString(16)} ${spY.toString(16)}`, 16);

        const r = gl.getR(secrets);
        const S = gl.unblindSignature(sPrime, r);
        const [sx, sy] = g1ToBigInts(S);

        // Local BLS verification
        if (config.mintBlsPubkey) {
            const Y = gl.blindToken(gl.getSpendAddressBytes(secrets), r).Y;
            const blsOk = gl.verifyBlsPairing(S, Y, config.mintBlsPubkey);
            if (blsOk) {
                ok('BLS pairing verified locally ✓');
            } else {
                err('BLS pairing FAILED — check MINT_BLS_PUBKEY');
            }
        }

        // Check nullifier on-chain
        const nullifier = getAddress(gl.getSpendAddress(secrets));
        const isSpent = await publicClient.readContract({
            address: config.contractAddress,
            abi: GHOST_VAULT_ABI,
            functionName: 'spentNullifiers',
            args: [nullifier],
        }) as boolean;

        rec.s_unblinded_x = `0x${sx.toString(16)}`;
        rec.s_unblinded_y = `0x${sy.toString(16)}`;
        rec.spent = isSpent;
        recovered++;

        log(`  → ${isSpent ? 'SPENT' : 'READY_TO_REDEEM'}`);
    }

    state.last_scanned_block = Number(latestBlock);
    saveWalletState(state);

    console.log(`\n  Scan complete: ${recovered} token(s) recovered · block ${latestBlock} saved`);
}

// ==============================================================================
// COMMAND: redeem
// ==============================================================================

async function cmdRedeem(config: Config, tokenIndex: number, recipient: string) {
    console.log(`\n👻  GHOST-TIP TS CLIENT  👻\n`);
    section(`💸  REDEEM · Token #${tokenIndex} → ${recipient}`);

    const state = loadWalletState();
    const rec = state.tokens[String(tokenIndex)];

    if (!rec) { err(`Token ${tokenIndex} not found. Run deposit first.`); process.exit(1); }
    if (rec.spent) { err(`Token ${tokenIndex} already spent.`); process.exit(1); }
    if (!rec.s_unblinded_x) { err(`Token ${tokenIndex} has no unblinded sig. Run scan first.`); process.exit(1); }

    const secrets = gl.deriveTokenSecrets(config.masterSeed, tokenIndex);

    // Step 1: load S and verify BLS
    section('🔓  Step 1 · Load Unblinded Signature');
    const sx = BigInt(rec.s_unblinded_x);
    const sy = BigInt(rec.s_unblinded_y!);
    kv('S.x', shortHex(`0x${sx.toString(16)}`));
    kv('S.y', shortHex(`0x${sy.toString(16)}`));

    // Local BLS verification
    if (config.mintBlsPubkey) {
        const S = new mcl.G1();
        S.setStr(`1 ${sx.toString(16)} ${sy.toString(16)}`, 16);
        const r = gl.getR(secrets);
        const Y = gl.blindToken(gl.getSpendAddressBytes(secrets), r).Y;
        const blsOk = gl.verifyBlsPairing(S, Y, config.mintBlsPubkey);
        if (blsOk) {
            ok('BLS pairing verified locally ✓');
        } else {
            err('BLS pairing FAILED — this token will be rejected on-chain.');
            process.exit(1);
        }
    } else {
        log('MINT_BLS_PUBKEY not configured — skipping local BLS check.');
    }

    // Step 2: derive spend key
    section('🔑  Step 2 · Derive Spend Key');
    const spendAddr = gl.getSpendAddress(secrets);
    kv('Spend address (nullifier)', spendAddr);
    kv('Deposit ID', gl.getDepositId(secrets));

    // Step 3: generate ECDSA proof
    section('🛡️  Step 3 · Generate Anti-MEV ECDSA Proof');
    const recipientAddr = getAddress(recipient);
    const proof = await gl.generateRedemptionProof(gl.getSpendPriv(secrets), recipientAddr);

    kv('msg_hash', shortHex(Buffer.from(proof.msgHash).toString('hex')));
    kv('compact_hex', shortHex('0x' + proof.compactHex));
    kv('recovery_bit', String(proof.recoveryBit));
    kv('v (EVM)', String(proof.recoveryBit + 27));

    // Local ecrecover check
    const ecdsaOk = gl.verifyEcdsaMevProtection(proof, spendAddr);
    if (ecdsaOk) {
        ok('Local ecrecover check passed');
    } else {
        err('Local ECDSA verification failed — aborting.');
        process.exit(1);
    }

    const spendSig = encodeSpendSignature(proof.compactHex, proof.recoveryBit);
    const nullifier = getAddress(spendAddr);

    // Step 4: build and send redeem tx
    section('📋  Step 4 · Build redeem() Transaction');
    const { publicClient, walletClient } = await buildClients(config);

    kv('Recipient', recipientAddr);
    kv('Nullifier', nullifier);
    kv('S.x', shortHex(`0x${sx.toString(16)}`));
    kv('S.y', shortHex(`0x${sy.toString(16)}`));

    section('📡  Step 5 · Broadcast');
    try {
        const hash = await walletClient.writeContract({
            address: config.contractAddress,
            abi: GHOST_VAULT_ABI,
            functionName: 'redeem',
            args: [recipientAddr, spendSig, nullifier, [sx, sy]],
        });

        kv('Transaction sent', hash);
        log('Waiting for confirmation…');

        const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
        if (receipt.status !== 'success') {
            err(`Transaction REVERTED tx=${hash}`);
            process.exit(1);
        }

        kv('Confirmed block', String(receipt.blockNumber));
        kv('Gas used', String(receipt.gasUsed));

        ok('On-chain checks passed:');
        log('  ✔  ecrecover → nullifier matches spend address');
        log('  ✔  spentNullifiers[nullifier] was false');
        log('  ✔  ecPairing: e(S, G2) == e(H(nullifier), PK_mint)');
        log(`  ✔  0.001 ETH transferred to ${recipientAddr}`);

        rec.redeem_tx = hash;
        rec.spent = true;
        saveWalletState(state);

        ok(`Redemption complete. Token ${tokenIndex} is now spent.`);

    } catch (e: any) {
        err(`Contract error: ${e.shortMessage || e.message}`);
        process.exit(1);
    }
}

// ==============================================================================
// COMMAND: balance
// ==============================================================================

async function cmdBalance(config: Config) {
    console.log(`\n👻  GHOST-TIP TS CLIENT  👻\n`);
    section('💰  Balance');
    const { publicClient } = await buildClients(config);
    const balance = await publicClient.getBalance({ address: config.walletAddress });
    kv('Wallet address', config.walletAddress);
    kv('Balance', `${formatEther(balance)} ETH`);
}

// ==============================================================================
// CLI ENTRY POINT
// ==============================================================================

async function main() {
    await initBN254();

    const args = process.argv.slice(2);
    const command = args[0];

    function getArg(name: string, fallback?: string): string {
        const idx = args.indexOf(name);
        if (idx === -1 || idx + 1 >= args.length) {
            if (fallback !== undefined) return fallback;
            throw new Error(`Missing required argument: ${name}`);
        }
        return args[idx + 1];
    }

    const config = loadConfig();

    switch (command) {
        case 'deposit': {
            const index = parseInt(getArg('--index'));
            await cmdDeposit(config, index);
            break;
        }
        case 'scan': {
            const from = parseInt(getArg('--index-from', '0'));
            const to = parseInt(getArg('--index-to', '9'));
            await cmdScan(config, from, to);
            break;
        }
        case 'redeem': {
            const index = parseInt(getArg('--index'));
            const to = getArg('--to');
            await cmdRedeem(config, index, to);
            break;
        }
        case 'balance': {
            await cmdBalance(config);
            break;
        }
        default:
            console.log('Ghost-Tip TS Client');
            console.log('');
            console.log('Usage:');
            console.log('  npx tsx client.ts deposit --index <n>');
            console.log('  npx tsx client.ts scan [--index-from <n>] [--index-to <n>]');
            console.log('  npx tsx client.ts redeem --index <n> --to <address>');
            console.log('  npx tsx client.ts balance');
            break;
    }
}

main().catch(e => {
    console.error('Fatal:', e.message || e);
    process.exit(1);
});
