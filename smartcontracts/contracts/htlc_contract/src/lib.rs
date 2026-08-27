#![no_std]

//! Hash Time-Locked Contract for the Stellar leg of a Lumina cross-chain swap.
//!
//! A swap is locked by the party sending funds on this chain, and can then go
//! exactly one of two ways:
//!
//! * the recipient reveals the preimage of the hashlock before `timeout_ledger`
//!   and takes the funds (`claim`), or
//! * the timelock expires and the sender takes the funds back (`refund`).
//!
//! Both outcomes are terminal, so funds can never be locked indefinitely. The
//! preimage revealed by `claim` is stored on-chain, which is what lets the
//! coordinator settle the counterparty leg on Ethereum, Polygon, Bitcoin, or
//! Solana with the same secret.

mod logic;
mod storage;
mod types;

#[cfg(test)]
mod test;

use soroban_sdk::{contract, contractimpl, symbol_short, token, Address, BytesN, Env};

pub use types::{Error, Swap, SwapStatus};

#[contract]
pub struct HtlcContract;

#[contractimpl]
impl HtlcContract {
    /// Locks `amount` of `token` under `secret_hash` until `timeout_ledger`.
    ///
    /// The funds move from `sender` into the contract's own balance. Only
    /// `recipient` can claim them, and only `sender` can refund them.
    pub fn lock(
        env: Env,
        swap_id: BytesN<32>,
        sender: Address,
        recipient: Address,
        token_address: Address,
        amount: i128,
        secret_hash: BytesN<32>,
        timeout_ledger: u32,
    ) -> Result<(), Error> {
        sender.require_auth();

        logic::validate_lock(&env, &swap_id, &sender, &recipient, amount, timeout_ledger)?;

        token::Client::new(&env, &token_address).transfer(
            &sender,
            &env.current_contract_address(),
            &amount,
        );

        let swap = Swap {
            swap_id: swap_id.clone(),
            sender: sender.clone(),
            recipient: recipient.clone(),
            token: token_address,
            amount,
            secret_hash,
            timeout_ledger,
            status: SwapStatus::Locked,
            created_at: env.ledger().timestamp(),
        };

        storage::save_swap(&env, &swap);

        env.events().publish(
            (symbol_short!("locked"), swap_id),
            (sender, recipient, amount, timeout_ledger),
        );

        Ok(())
    }

    /// Claims a locked swap by revealing the preimage of its hashlock.
    ///
    /// Rejected once the timelock has expired, so the sender's refund window is
    /// never contested by a late claim.
    pub fn claim(env: Env, swap_id: BytesN<32>, preimage: BytesN<32>) -> Result<(), Error> {
        let mut swap = logic::load_locked_swap(&env, &swap_id)?;

        swap.recipient.require_auth();

        if env.ledger().sequence() >= swap.timeout_ledger {
            return Err(Error::TimelockExpired);
        }

        logic::verify_preimage(&env, &swap.secret_hash, &preimage)?;

        swap.status = SwapStatus::Claimed;
        storage::save_swap(&env, &swap);
        storage::save_preimage(&env, &swap_id, &preimage);

        logic::pay_out(&env, &swap.token, &swap.recipient, swap.amount);

        env.events().publish(
            (symbol_short!("claimed"), swap_id),
            (swap.recipient, swap.amount, preimage),
        );

        Ok(())
    }

    /// Returns a locked swap's funds to the sender once the timelock expires.
    pub fn refund(env: Env, swap_id: BytesN<32>) -> Result<(), Error> {
        let mut swap = logic::load_locked_swap(&env, &swap_id)?;

        swap.sender.require_auth();

        if env.ledger().sequence() < swap.timeout_ledger {
            return Err(Error::TimelockNotExpired);
        }

        swap.status = SwapStatus::Refunded;
        storage::save_swap(&env, &swap);

        logic::pay_out(&env, &swap.token, &swap.sender, swap.amount);

        env.events()
            .publish((symbol_short!("refunded"), swap_id), (swap.sender, swap.amount));

        Ok(())
    }

    /// Returns the swap record, or `None` if `swap_id` was never locked.
    pub fn get_swap(env: Env, swap_id: BytesN<32>) -> Option<Swap> {
        storage::get_swap(&env, &swap_id)
    }

    /// Returns the preimage revealed by `claim`, or `None` if unclaimed.
    pub fn get_preimage(env: Env, swap_id: BytesN<32>) -> Option<BytesN<32>> {
        storage::get_preimage(&env, &swap_id)
    }
}
