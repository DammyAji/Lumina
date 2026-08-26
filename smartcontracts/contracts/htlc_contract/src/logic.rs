use soroban_sdk::{token, Address, Bytes, BytesN, Env};

use crate::storage;
use crate::types::{Error, Swap, SwapStatus};

/// Validates the parameters a caller supplies to `lock`.
pub fn validate_lock(
    env: &Env,
    swap_id: &BytesN<32>,
    sender: &Address,
    recipient: &Address,
    amount: i128,
    timeout_ledger: u32,
) -> Result<(), Error> {
    if storage::swap_exists(env, swap_id) {
        return Err(Error::SwapAlreadyExists);
    }

    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }

    if sender == recipient {
        return Err(Error::SameSenderAndRecipient);
    }

    // A timelock that is already in the past would let the sender refund
    // immediately, which defeats the point of locking the funds at all.
    if timeout_ledger <= env.ledger().sequence() {
        return Err(Error::InvalidTimeout);
    }

    Ok(())
}

/// Loads a swap that must still be in the `Locked` state.
pub fn load_locked_swap(env: &Env, swap_id: &BytesN<32>) -> Result<Swap, Error> {
    let swap = storage::get_swap(env, swap_id).ok_or(Error::SwapNotFound)?;

    if swap.status != SwapStatus::Locked {
        return Err(Error::SwapNotLocked);
    }

    Ok(swap)
}

/// Returns `Ok(())` when `sha256(preimage)` matches the swap's hashlock.
pub fn verify_preimage(env: &Env, secret_hash: &BytesN<32>, preimage: &BytesN<32>) -> Result<(), Error> {
    let hashed: BytesN<32> = env
        .crypto()
        .sha256(&Bytes::from_array(env, &preimage.to_array()))
        .into();

    if &hashed != secret_hash {
        return Err(Error::InvalidPreimage);
    }

    Ok(())
}

/// Moves `amount` of `token` out of the contract's balance to `to`.
pub fn pay_out(env: &Env, token_address: &Address, to: &Address, amount: i128) {
    token::Client::new(env, token_address).transfer(&env.current_contract_address(), to, &amount);
}
