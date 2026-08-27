#![cfg(test)]

use solana_program::{hash::hash, pubkey::Pubkey};

use crate::error::HtlcError;
use crate::instruction::HtlcInstruction;
use crate::logic;
use crate::state::{HtlcSwap, SwapStatus};

const NOW: i64 = 1_000_000;
const TIMEOUT: i64 = NOW + 3_600;
const AMOUNT: u64 = 500;

fn preimage() -> [u8; 32] {
    [7u8; 32]
}

fn secret_hash() -> [u8; 32] {
    hash(&preimage()).to_bytes()
}

fn locked_swap(sender: Pubkey, recipient: Pubkey) -> HtlcSwap {
    HtlcSwap {
        swap_id: [1u8; 32],
        sender,
        recipient,
        vault: Pubkey::new_unique(),
        amount: AMOUNT,
        secret_hash: secret_hash(),
        timeout_unix: TIMEOUT,
        status: SwapStatus::Locked,
        preimage: [0u8; 32],
    }
}

#[test]
fn validate_lock_accepts_a_well_formed_lock() {
    let sender = Pubkey::new_unique();
    let recipient = Pubkey::new_unique();

    assert_eq!(
        logic::validate_lock(&sender, &recipient, AMOUNT, TIMEOUT, NOW, true),
        Ok(())
    );
}

#[test]
fn validate_lock_rejects_an_already_initialized_swap_account() {
    let sender = Pubkey::new_unique();
    let recipient = Pubkey::new_unique();

    assert_eq!(
        logic::validate_lock(&sender, &recipient, AMOUNT, TIMEOUT, NOW, false),
        Err(HtlcError::SwapAlreadyExists)
    );
}

#[test]
fn validate_lock_rejects_a_zero_amount() {
    let sender = Pubkey::new_unique();
    let recipient = Pubkey::new_unique();

    assert_eq!(
        logic::validate_lock(&sender, &recipient, 0, TIMEOUT, NOW, true),
        Err(HtlcError::InvalidAmount)
    );
}

#[test]
fn validate_lock_rejects_a_swap_to_the_sender() {
    let sender = Pubkey::new_unique();

    assert_eq!(
        logic::validate_lock(&sender, &sender, AMOUNT, TIMEOUT, NOW, true),
        Err(HtlcError::InvalidRecipient)
    );
}

#[test]
fn validate_lock_rejects_a_timeout_that_is_not_in_the_future() {
    let sender = Pubkey::new_unique();
    let recipient = Pubkey::new_unique();

    assert_eq!(
        logic::validate_lock(&sender, &recipient, AMOUNT, NOW, NOW, true),
        Err(HtlcError::InvalidTimeout)
    );
}

#[test]
fn verify_preimage_accepts_the_matching_secret() {
    assert_eq!(logic::verify_preimage(&secret_hash(), &preimage()), Ok(()));
}

#[test]
fn verify_preimage_rejects_a_wrong_secret() {
    assert_eq!(
        logic::verify_preimage(&secret_hash(), &[8u8; 32]),
        Err(HtlcError::InvalidPreimage)
    );
}

#[test]
fn validate_claim_accepts_the_recipient_before_the_timeout() {
    let sender = Pubkey::new_unique();
    let recipient = Pubkey::new_unique();
    let swap = locked_swap(sender, recipient);

    assert_eq!(
        logic::validate_claim(&swap, &recipient, &preimage(), NOW),
        Ok(())
    );
}

#[test]
fn validate_claim_rejects_anyone_but_the_recipient() {
    let sender = Pubkey::new_unique();
    let recipient = Pubkey::new_unique();
    let swap = locked_swap(sender, recipient);

    assert_eq!(
        logic::validate_claim(&swap, &sender, &preimage(), NOW),
        Err(HtlcError::InvalidRecipient)
    );
}

#[test]
fn validate_claim_rejects_an_expired_timelock() {
    let sender = Pubkey::new_unique();
    let recipient = Pubkey::new_unique();
    let swap = locked_swap(sender, recipient);

    assert_eq!(
        logic::validate_claim(&swap, &recipient, &preimage(), TIMEOUT),
        Err(HtlcError::TimelockExpired)
    );
}

#[test]
fn validate_claim_rejects_a_swap_that_is_no_longer_locked() {
    let sender = Pubkey::new_unique();
    let recipient = Pubkey::new_unique();
    let mut swap = locked_swap(sender, recipient);
    swap.status = SwapStatus::Claimed;

    assert_eq!(
        logic::validate_claim(&swap, &recipient, &preimage(), NOW),
        Err(HtlcError::SwapNotLocked)
    );
}

#[test]
fn validate_refund_accepts_the_sender_after_the_timeout() {
    let sender = Pubkey::new_unique();
    let recipient = Pubkey::new_unique();
    let swap = locked_swap(sender, recipient);

    assert_eq!(logic::validate_refund(&swap, &sender, TIMEOUT), Ok(()));
}

#[test]
fn validate_refund_rejects_a_timelock_that_has_not_expired() {
    let sender = Pubkey::new_unique();
    let recipient = Pubkey::new_unique();
    let swap = locked_swap(sender, recipient);

    assert_eq!(
        logic::validate_refund(&swap, &sender, NOW),
        Err(HtlcError::TimelockNotExpired)
    );
}

#[test]
fn validate_refund_rejects_a_swap_that_was_already_claimed() {
    let sender = Pubkey::new_unique();
    let recipient = Pubkey::new_unique();
    let mut swap = locked_swap(sender, recipient);
    swap.status = SwapStatus::Claimed;

    assert_eq!(
        logic::validate_refund(&swap, &sender, TIMEOUT),
        Err(HtlcError::SwapNotLocked)
    );
}

#[test]
fn swap_state_round_trips_through_pack_and_unpack() {
    let swap = locked_swap(Pubkey::new_unique(), Pubkey::new_unique());
    let mut buf = vec![0u8; HtlcSwap::LEN];

    swap.pack(&mut buf).unwrap();

    assert_eq!(HtlcSwap::unpack(&buf).unwrap(), swap);
}

#[test]
fn a_zeroed_account_reads_as_uninitialized() {
    let buf = vec![0u8; HtlcSwap::LEN];
    assert!(HtlcSwap::is_uninitialized(&buf));

    let swap = locked_swap(Pubkey::new_unique(), Pubkey::new_unique());
    let mut written = vec![0u8; HtlcSwap::LEN];
    swap.pack(&mut written).unwrap();
    assert!(!HtlcSwap::is_uninitialized(&written));
}

#[test]
fn pack_rejects_an_account_that_is_too_small() {
    let swap = locked_swap(Pubkey::new_unique(), Pubkey::new_unique());
    let mut buf = vec![0u8; HtlcSwap::LEN - 1];

    assert!(swap.pack(&mut buf).is_err());
}

#[test]
fn lock_instruction_round_trips() {
    let instruction = HtlcInstruction::Lock {
        swap_id: [1u8; 32],
        recipient: Pubkey::new_unique(),
        amount: AMOUNT,
        secret_hash: secret_hash(),
        timeout_unix: TIMEOUT,
    };

    assert_eq!(HtlcInstruction::unpack(&instruction.pack()).unwrap(), instruction);
}

#[test]
fn claim_and_refund_instructions_round_trip() {
    let claim = HtlcInstruction::Claim {
        preimage: preimage(),
    };
    assert_eq!(HtlcInstruction::unpack(&claim.pack()).unwrap(), claim);

    let refund = HtlcInstruction::Refund;
    assert_eq!(HtlcInstruction::unpack(&refund.pack()).unwrap(), refund);
}

#[test]
fn unpack_rejects_an_unknown_tag_and_a_truncated_payload() {
    assert!(HtlcInstruction::unpack(&[]).is_err());
    assert!(HtlcInstruction::unpack(&[9]).is_err());
    assert!(HtlcInstruction::unpack(&[0, 1, 2, 3]).is_err());
    assert!(HtlcInstruction::unpack(&[1, 1, 2, 3]).is_err());
}
