# HTLC Contracts

Hash Time-Locked Contracts for Lumina's cross-chain atomic swaps. One
implementation per supported chain, all sharing the same hashlock so a single
secret settles every leg of a swap:

| Chain | Implementation | Tests |
|---|---|---|
| Stellar (Soroban) | `contracts/htlc_contract` (Rust) | `cargo test -p htlc-contract` |
| Ethereum, Polygon | `evm/src/LuminaHTLC.sol` (Solidity) | `cd evm && forge test` |
| Solana | `solana/htlc_program` (Rust) | `cd solana/htlc_program && cargo test` |
| Bitcoin | P2SH/P2WSH redeem script built in the backend | `backend`: `npx jest src/cross-chain-swap/chains/bitcoin-htlc.script.spec.ts` |

## The swap rules

Every implementation enforces the same three invariants:

1. **Hashlock.** Funds are released to the recipient only against a `preimage`
   where `sha256(preimage) == secret_hash`. sha256 — not keccak256 — is used
   everywhere so the identical hash works on Bitcoin's `OP_SHA256`.
2. **Timelock.** After the timeout the sender, and only the sender, can refund.
   Claims are rejected at or after the timeout, so a late claim can never race
   the refund window.
3. **Terminal outcomes.** `Claimed` and `Refunded` are both final. There is no
   path that leaves funds locked indefinitely.

The preimage revealed by a claim is stored on-chain by every implementation.
That is what lets the coordinator watch one chain, learn the secret, and settle
the counterparty leg with it.

## Timelock ordering

The counterparty (Stellar) leg must always expire **before** the leg the
customer funds. Otherwise the customer could refund their side while the
Stellar side is still claimable and end up with both. The backend enforces the
gap; see `docs/CROSS_CHAIN_SWAPS.md`.

## Stellar (Soroban)

```bash
cd smartcontracts
cargo test -p htlc-contract
cargo build -p htlc-contract --target wasm32-unknown-unknown --release
```

`lock` moves the tokens into the contract's own balance, `claim` verifies the
preimage and pays the recipient, `refund` returns the funds after
`timeout_ledger`. Timeouts are expressed in ledger sequence numbers.

## Ethereum / Polygon

```bash
cd smartcontracts/evm
forge test
forge build
```

`LuminaHTLC` supports both native currency (`lockNative`) and ERC-20
(`lockERC20`). Timeouts are unix timestamps. The tests declare the Foundry
cheatcode interface locally, so no `lib/` vendoring or `forge install` is
needed to run them.

## Solana

```bash
cd smartcontracts/solana/htlc_program
cargo test                                  # host-side unit tests
cargo build-sbf                             # requires the Solana toolchain
```

SPL tokens are escrowed in a vault owned by the per-swap PDA derived from
`["swap", swap_id]`. The swap rules live in `logic.rs` as pure functions so
they can be unit-tested without a BPF runtime; `processor.rs` holds the account
plumbing and CPI calls, which need `cargo build-sbf` and a validator to
exercise.

## Bitcoin

Bitcoin has no contract to deploy — the HTLC is a redeem script. The backend
builds and verifies it; see `backend/src/cross-chain-swap/chains/bitcoin-htlc.script.ts`.
