//! Pure guard functions shared by the processor.
//!
//! Keeping them free of `AccountInfo` means the swap rules can be unit-tested
//! on the host without a BPF runtime.

use solana_program::{hash::hash, pubkey::Pubkey};

use crate::error::HtlcError;
use crate::state::{HtlcSwap, SwapStatus};

pub fn validate_lock(
    sender: &Pubkey,
    recipient: &Pubkey,
    amount: u64,
    timeout_unix: i64,
    now: i64,
    swap_account_is_uninitialized: bool,
) -> Result<(), HtlcError> {
    if !swap_account_is_uninitialized {
        return Err(HtlcError::SwapAlreadyExists);
    }

    if amount == 0 {
        return Err(HtlcError::InvalidAmount);
    }

    if sender == recipient {
        return Err(HtlcError::InvalidRecipient);
    }

    // A timelock already in the past would let the sender refund immediately,
    // which defeats the point of escrowing the funds at all.
    if timeout_unix <= now {
        return Err(HtlcError::InvalidTimeout);
    }

    Ok(())
}

/// `sha256(preimage) == secret_hash`. sha256 is used rather than keccak256 so
/// the same hashlock works unchanged on Bitcoin, Ethereum, and Stellar.
pub fn verify_preimage(secret_hash: &[u8; 32], preimage: &[u8; 32]) -> Result<(), HtlcError> {
    if hash(preimage).to_bytes() != *secret_hash {
        return Err(HtlcError::InvalidPreimage);
    }

    Ok(())
}

pub fn validate_claim(
    swap: &HtlcSwap,
    signer: &Pubkey,
    preimage: &[u8; 32],
    now: i64,
) -> Result<(), HtlcError> {
    if swap.status != SwapStatus::Locked {
        return Err(HtlcError::SwapNotLocked);
    }

    if signer != &swap.recipient {
        return Err(HtlcError::InvalidRecipient);
    }

    // Rejected once the timelock has expired, so a late claim can never race
    // the sender's refund window.
    if now >= swap.timeout_unix {
        return Err(HtlcError::TimelockExpired);
    }

    verify_preimage(&swap.secret_hash, preimage)
}

pub fn validate_refund(swap: &HtlcSwap, signer: &Pubkey, now: i64) -> Result<(), HtlcError> {
    if swap.status != SwapStatus::Locked {
        return Err(HtlcError::SwapNotLocked);
    }

    if signer != &swap.sender {
        return Err(HtlcError::InvalidRecipient);
    }

    if now < swap.timeout_unix {
        return Err(HtlcError::TimelockNotExpired);
    }

    Ok(())
}
