# Cross-Chain Atomic Swaps

Lumina accepts payments on Ethereum, Polygon, Bitcoin, and Solana and settles
them to merchants as USDC on Stellar. The two halves of that trade happen on
chains that cannot see each other, so they are bound together with Hash
Time-Locked Contracts: one secret unlocks both legs, and a timelock guarantees
that anything left unsettled comes back to whoever funded it.

- [How a swap works](#how-a-swap-works)
- [Why it is atomic](#why-it-is-atomic)
- [Timelock ordering](#timelock-ordering)
- [State machine](#state-machine)
- [Components](#components)
- [Supported chains](#supported-chains)
- [API](#api)
- [Configuration](#configuration)
- [Failure modes](#failure-modes)
- [Testing](#testing)

## How a swap works

```
Customer                    Lumina                      Merchant
   │                          │                            │
   │  1. POST /api/swaps/initiate                          │
   │◄─────────────────────────┤ generates secret S         │
   │   lock request           │ hashlock H = sha256(S)     │
   │                          │                            │
   │  2. locks funds on the source chain under H           │
   ├──────────────────►[ source HTLC ]                     │
   │                          │                            │
   │                    3. waits for confirmations         │
   │                          │                            │
   │                    4. locks USDC under the same H     │
   │                          ├──────────►[ Stellar HTLC ] │
   │                          │                            │
   │                    5. claims with S ──────────────────►
   │                          │        merchant is paid    │
   │                          │        S is now public     │
   │                          │                            │
   │                    6. claims the source leg with S    │
   │                    ◄─────┤                            │
```

Steps 5 and 6 are what the whole design turns on. Claiming on Stellar publishes
the preimage on-chain; Lumina then replays that same preimage against the source
HTLC. One secret, both legs.

## Why it is atomic

Every HTLC — Soroban, Solidity, the Bitcoin script, the Solana program —
enforces the same three rules:

1. **Hashlock.** Funds go to the recipient only against a `preimage` where
   `sha256(preimage) == secret_hash`. sha256 rather than keccak256, so the same
   hash works unchanged under Bitcoin's `OP_SHA256`.
2. **Timelock.** After the timeout the *sender*, and only the sender, can
   refund. Claims are rejected at or after the timeout, so a late claim never
   races the refund window.
3. **Terminal outcomes.** `Claimed` and `Refunded` are both final. No path
   leaves funds locked indefinitely.

So each leg ends in exactly one of two states, and because both legs share a
hashlock, the first claim reveals the secret that settles the other.

## Timelock ordering

The Stellar leg must always expire **before** the source leg.

If it were the other way round, there would be a window where the customer's
source HTLC has expired — refundable — while Lumina's Stellar HTLC is still
claimable. The customer could refund their payment and claim the USDC.

`planTimelocks()` enforces a gap of at least `MIN_TIMELOCK_GAP_SECONDS` (one
hour) and rejects any pair that does not have it, so a misconfigured
`SWAP_SOURCE_TIMEOUT_SECONDS` fails at initiation rather than silently making
swaps unsafe.

Each chain expresses its timeout in its own unit:

| Chain | Unit | Enforced by |
|---|---|---|
| Ethereum, Polygon | unix seconds | `block.timestamp` |
| Solana | unix seconds | `Clock::unix_timestamp` |
| Bitcoin | block height | `OP_CHECKLOCKTIMEVERIFY` |
| Stellar | ledger sequence | `env.ledger().sequence()` |

## State machine

```
pending ──► source_locked ──► target_locked ──► target_claimed ──► completed
   │              │                  │
   └──► expired   └──────────────────┴──► refund_pending ──► refunded
```

| Status | Meaning |
|---|---|
| `pending` | Waiting for the customer to fund the source HTLC |
| `source_locked` | Source lock confirmed to the chain's reorg depth |
| `target_locked` | Lumina has funded the merchant's Stellar HTLC |
| `target_claimed` | Merchant claimed; the secret is public |
| `completed` | Lumina claimed the source leg. Terminal |
| `refund_pending` | A timelock expired; refunds are being broadcast |
| `refunded` | Funds returned to their owners. Terminal |
| `expired` | Never funded before the deadline. Terminal |
| `failed` | Retries exhausted with no refund path. Terminal |

`target_claimed` is the point of no return. Before it, no secret is public and
both legs are independently refundable. After it, the swap can only complete —
which is why `POST /:id/refund` rejects a swap that has reached it.

Each `advance()` takes at most one step, and is safe to run repeatedly: every
transition re-reads the chain and no-ops if the step already happened. That is
what lets the listener poll on a fixed timer and lets any failure be retried
without risking a double broadcast.

## Components

| Service | Responsibility |
|---|---|
| `CrossChainSwapService` | The coordinator. Owns the state machine and the API surface |
| `ChainListenerService` | Polls all configured chains every 30s and advances due swaps |
| `RefundService` | Broadcasts refunds once timelocks expire; runs every minute |
| `SecretManagerService` | Generates secrets, seals them with AES-256-GCM, verifies preimages |
| `GasPriceOracleService` | Per-chain fee quotes with an optional ceiling |
| `ChainRegistryService` | Resolves a chain to its adapter and reports what is configured |

### Chain adapters

One `HtlcChainAdapter` per network, all read-and-build only: they observe the
chain and produce *unsigned* calls. Nothing in the module holds a key.

Signing sits behind the `SWAP_BROADCASTER` port, so a deployment plugs in
whatever custody it runs — an HSM, a KMS, a remote signer — without the swap
state machine ever touching key material. Deployments that have not wired one up
get `UnconfiguredSwapBroadcaster`, which fails loudly rather than dropping calls
silently.

The adapters talk to each chain over its own native transport rather than
pulling in a per-chain SDK: JSON-RPC for the EVM chains and Solana, an
Esplora-compatible REST API for Bitcoin, and the existing
`@stellar/stellar-sdk` RPC client for Stellar.

### Concurrency

Both workers advance a swap under a Redis lock keyed `swap:<swap_id>`, reusing
`DistributedLockService`. Several backend replicas can run the listener at once
without two of them broadcasting the same claim; a replica that cannot take the
lock skips that swap and picks it up next cycle.

### Retries

Failures back off exponentially (30s base, capped at 30 minutes, 5 attempts).
A swap that exhausts its attempts moves into `refund_pending` rather than
`failed` whenever a refund path still exists — the safe direction is always
"give the money back".

## Supported chains

| Chain | HTLC | Confirmations | Notes |
|---|---|---|---|
| Ethereum | `LuminaHTLC.sol` | 12 | Native ETH or any ERC-20 |
| Polygon | `LuminaHTLC.sol` | 128 | Deeper depth: Polygon reorgs are deeper and cheaper to cause |
| Bitcoin | P2SH/P2WSH redeem script | 3 | Both legacy and SegWit addresses are offered |
| Solana | `lumina-htlc-solana` | n/a | Read at `confirmed` commitment |
| Stellar | `htlc_contract` (Soroban) | 1 | Target only — where merchants are paid |

Contract sources and their tests live under `smartcontracts/`; see
`smartcontracts/contracts/htlc_contract/README.md`.

## API

### `POST /api/swaps/initiate`

Creates a swap and returns what the customer must do on the source chain.
Nothing is broadcast — the customer funds their own leg.

```json
{
  "source_chain": "ethereum",
  "source_address": "0xCustomer…",
  "target_address": "GMERCHANT…",
  "amount": "1.5",
  "source_asset": "ETH",
  "payment_id": "pay_123"
}
```

`amount` is a decimal **string**, not a number, so an 18-decimal value does not
lose precision to a float.

```json
{
  "swap": { "swap_id": "…", "status": "pending", "timeout_block": "1700086400" },
  "lockRequest": {
    "chain": "ethereum",
    "htlcAddress": "0x…",
    "amount": "1500000000000000000",
    "secretHash": "…",
    "timeout": "1700086400",
    "payload": "0x170b2ab0…",
    "metadata": { "recipient": "0x…", "valueWei": "1500000000000000000" }
  }
}
```

On Bitcoin, `metadata` carries both `p2wshAddress` and `p2shAddress` for the
same script, plus the `redeemScript` itself. On Solana it carries the swap PDA.

**Errors:** `SWAP_CHAIN_UNSUPPORTED` for a chain Lumina does not swap from, or
`503` with the same code for one this deployment has not configured.

### `GET /api/swaps/:id`

Returns the swap. The sealed secret is never included in any response.

### `POST /api/swaps/:id/refund`

Marks a swap for refund. Accepted only once the source timelock has actually
expired and while the swap is still refundable.

**Errors:** `SWAP_TIMELOCK_NOT_EXPIRED` (409) before the timelock,
`SWAP_NOT_REFUNDABLE` (409) once the secret is public, `SWAP_NOT_FOUND` (404).

### `GET /api/swaps/supported-chains`

Lists every source chain with its parameters and whether it is configured here.

```json
[
  {
    "chain": "ethereum",
    "displayName": "Ethereum",
    "nativeAsset": "ETH",
    "decimals": 18,
    "timeoutUnit": "unix_seconds",
    "requiredConfirmations": 12,
    "configured": true
  }
]
```

## Configuration

All swap settings are optional; an unconfigured chain is simply not offered.
See the `Cross-Chain Atomic Swaps` block in `.env.example` for the full list.

The one to get right before going live is `SWAP_SECRET_ENCRYPTION_KEY`
(32 bytes of hex). Without it the backend seals secrets under an ephemeral key
and logs a warning — in-flight swaps then become unclaimable across a restart,
and have to wait for their timelocks to refund.

## Failure modes

| Situation | What happens |
|---|---|
| Customer never funds | `expired` at the deadline. Nothing was ever locked |
| Lock has the wrong hashlock | Rejected. Lumina pays out nothing it cannot claim back |
| Lock underpays | Rejected with `SWAP_AMOUNT_MISMATCH`; overpaying is accepted |
| Chain reorg unmines the lock | Confirmations drop below the threshold and the swap waits again |
| Source RPC down | Exponential backoff, then `refund_pending` |
| Gas spike | Discretionary claims defer while a fee ceiling is set; refunds never do |
| Timeout mid-flight | `refund_pending`. Lumina refunds Stellar; the customer refunds their own leg |
| Source timelock beat the claim | `failed` with `manual reconciliation required` — the secret is public, so neither side can refund cleanly |

The last row is the only outcome that needs a human, and it is reachable only if
Lumina cannot get a claim mined within a full timelock window after the secret
went public.

## Testing

```bash
# Backend
cd backend && npx jest src/cross-chain-swap

# Soroban HTLC
cd smartcontracts && cargo test -p htlc-contract

# Solidity HTLC
cd smartcontracts/evm && forge test

# Solana HTLC
cd smartcontracts/solana/htlc_program && cargo test
```

`backend/src/cross-chain-swap/e2e/swap-lifecycle.e2e-spec.ts` runs the
coordinator, listener, and refund worker together against in-memory HTLCs that
enforce the same hashlock and timelock rules the real contracts do — including
the settle path, the refund path, expiry, a mismatched hashlock, and two
listeners racing for the same swap.
