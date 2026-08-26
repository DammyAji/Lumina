# Cross-Chain Swaps

Accepts payments from Ethereum, Polygon, Bitcoin, and Solana and settles them to
the merchant as USDC on Stellar, using Hash Time-Locked Contracts so neither
side can ever end up short.

Architecture and the full API reference live in
[`docs/CROSS_CHAIN_SWAPS.md`](../../../docs/CROSS_CHAIN_SWAPS.md); this file is
the map of the module itself.

## Layout

| File | Role |
|---|---|
| `cross-chain-swap.service.ts` | The coordinator — owns the swap state machine |
| `chain-listener.service.ts` | Polls every chain and advances due swaps |
| `refund.service.ts` | Returns funds when a swap times out instead of settling |
| `secret-manager.service.ts` | Generates, seals, and verifies swap preimages |
| `gas-price-oracle.service.ts` | Per-chain fee quotes and ceilings |
| `timelock.util.ts` | Turns durations into each chain's timeout unit |
| `chains/` | One adapter per network, plus the shared RPC clients |

## The state machine

```
pending ──► source_locked ──► target_locked ──► target_claimed ──► completed
   │              │                  │
   └──► expired   └──────────────────┴──► refund_pending ──► refunded
```

`advance()` reads the chains, decides on the single next step, and takes it.
It is re-entrant by design: running it twice is a no-op rather than a double
spend, which is what lets the listener poll on a timer and lets any failure
simply be retried.

`target_claimed` is the point of no return. Before it, no secret is public and
both legs are independently refundable; after it, the swap can only complete.

## Adding a chain

1. Add it to `SwapChain` and `CHAIN_METADATA` in `chains/chain.enum.ts`.
2. Implement `HtlcChainAdapter` for it under `chains/`.
3. Register the adapter in `chains/chain-registry.service.ts` and the module.
4. Deploy an HTLC that uses **sha256** as its hashlock — see
   `smartcontracts/contracts/htlc_contract/README.md`.

Adapters are read-and-build only. They observe the chain and produce unsigned
calls; nothing in this module holds a key. Signing sits behind the
`SWAP_BROADCASTER` port so a deployment can plug in whatever custody it runs.

## Configuration

Every chain is optional. An unconfigured chain simply does not appear in
`GET /api/swaps/supported-chains` and is rejected at initiation. See the
`Cross-Chain Atomic Swaps` block in `.env.example` for the full list.

`SWAP_SECRET_ENCRYPTION_KEY` is the one setting worth getting right before
going live: without it the backend seals secrets under an ephemeral key, and
in-flight swaps become unclaimable across a restart.

## Tests

```bash
cd backend
npx jest src/cross-chain-swap
```

`e2e/swap-lifecycle.e2e-spec.ts` drives the coordinator, listener, and refund
worker together against in-memory HTLCs that enforce the same hashlock and
timelock rules the real contracts do.
