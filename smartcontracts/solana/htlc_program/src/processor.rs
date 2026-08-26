use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
    entrypoint::ProgramResult,
    msg,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
    sysvar::Sysvar,
};

use crate::error::HtlcError;
use crate::instruction::HtlcInstruction;
use crate::logic;
use crate::state::{HtlcSwap, SwapStatus};

/// Seed prefix for the per-swap PDA that both stores the swap and owns its vault.
pub const SWAP_SEED_PREFIX: &[u8] = b"swap";

pub fn swap_pda(program_id: &Pubkey, swap_id: &[u8; 32]) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[SWAP_SEED_PREFIX, swap_id], program_id)
}

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    match HtlcInstruction::unpack(instruction_data)? {
        HtlcInstruction::Lock {
            swap_id,
            recipient,
            amount,
            secret_hash,
            timeout_unix,
        } => process_lock(
            program_id,
            accounts,
            swap_id,
            recipient,
            amount,
            secret_hash,
            timeout_unix,
        ),
        HtlcInstruction::Claim { preimage } => process_claim(program_id, accounts, preimage),
        HtlcInstruction::Refund => process_refund(program_id, accounts),
    }
}

fn process_lock(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    swap_id: [u8; 32],
    recipient: Pubkey,
    amount: u64,
    secret_hash: [u8; 32],
    timeout_unix: i64,
) -> ProgramResult {
    let iter = &mut accounts.iter();
    let sender = next_account_info(iter)?;
    let swap_account = next_account_info(iter)?;
    let sender_token_account = next_account_info(iter)?;
    let vault = next_account_info(iter)?;
    let token_program = next_account_info(iter)?;

    if !sender.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let (expected_pda, _bump) = swap_pda(program_id, &swap_id);
    if swap_account.key != &expected_pda || swap_account.owner != program_id {
        return Err(ProgramError::InvalidArgument);
    }

    let now = Clock::get()?.unix_timestamp;

    {
        let data = swap_account.try_borrow_data()?;
        logic::validate_lock(
            sender.key,
            &recipient,
            amount,
            timeout_unix,
            now,
            HtlcSwap::is_uninitialized(&data),
        )?;
    }

    // Move the tokens into the vault before recording the swap, so a failed
    // transfer leaves no state behind.
    invoke(
        &spl_token::instruction::transfer(
            token_program.key,
            sender_token_account.key,
            vault.key,
            sender.key,
            &[],
            amount,
        )?,
        &[
            sender_token_account.clone(),
            vault.clone(),
            sender.clone(),
            token_program.clone(),
        ],
    )?;

    let swap = HtlcSwap {
        swap_id,
        sender: *sender.key,
        recipient,
        vault: *vault.key,
        amount,
        secret_hash,
        timeout_unix,
        status: SwapStatus::Locked,
        preimage: [0u8; 32],
    };

    swap.pack(&mut swap_account.try_borrow_mut_data()?)?;
    msg!("htlc: locked {} until {}", amount, timeout_unix);

    Ok(())
}

fn process_claim(program_id: &Pubkey, accounts: &[AccountInfo], preimage: [u8; 32]) -> ProgramResult {
    let iter = &mut accounts.iter();
    let recipient = next_account_info(iter)?;
    let swap_account = next_account_info(iter)?;
    let vault = next_account_info(iter)?;
    let recipient_token_account = next_account_info(iter)?;
    let token_program = next_account_info(iter)?;

    if !recipient.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let mut swap = load_swap(program_id, swap_account)?;
    let now = Clock::get()?.unix_timestamp;

    logic::validate_claim(&swap, recipient.key, &preimage, now)?;

    if vault.key != &swap.vault {
        return Err(ProgramError::InvalidArgument);
    }

    swap.status = SwapStatus::Claimed;
    swap.preimage = preimage;
    swap.pack(&mut swap_account.try_borrow_mut_data()?)?;

    pay_out(
        program_id,
        &swap,
        swap_account,
        vault,
        recipient_token_account,
        token_program,
    )?;

    msg!("htlc: claimed");
    Ok(())
}

fn process_refund(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let iter = &mut accounts.iter();
    let sender = next_account_info(iter)?;
    let swap_account = next_account_info(iter)?;
    let vault = next_account_info(iter)?;
    let sender_token_account = next_account_info(iter)?;
    let token_program = next_account_info(iter)?;

    if !sender.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let mut swap = load_swap(program_id, swap_account)?;
    let now = Clock::get()?.unix_timestamp;

    logic::validate_refund(&swap, sender.key, now)?;

    if vault.key != &swap.vault {
        return Err(ProgramError::InvalidArgument);
    }

    swap.status = SwapStatus::Refunded;
    swap.pack(&mut swap_account.try_borrow_mut_data()?)?;

    pay_out(
        program_id,
        &swap,
        swap_account,
        vault,
        sender_token_account,
        token_program,
    )?;

    msg!("htlc: refunded");
    Ok(())
}

fn load_swap(program_id: &Pubkey, swap_account: &AccountInfo) -> Result<HtlcSwap, ProgramError> {
    if swap_account.owner != program_id {
        return Err(ProgramError::IllegalOwner);
    }

    let data = swap_account.try_borrow_data()?;
    if HtlcSwap::is_uninitialized(&data) {
        return Err(HtlcError::SwapNotFound.into());
    }

    HtlcSwap::unpack(&data)
}

/// Drains the vault to `destination`, signing as the swap PDA that owns it.
fn pay_out<'a>(
    program_id: &Pubkey,
    swap: &HtlcSwap,
    swap_account: &AccountInfo<'a>,
    vault: &AccountInfo<'a>,
    destination: &AccountInfo<'a>,
    token_program: &AccountInfo<'a>,
) -> ProgramResult {
    let (_pda, bump) = swap_pda(program_id, &swap.swap_id);

    invoke_signed(
        &spl_token::instruction::transfer(
            token_program.key,
            vault.key,
            destination.key,
            swap_account.key,
            &[],
            swap.amount,
        )?,
        &[
            vault.clone(),
            destination.clone(),
            swap_account.clone(),
            token_program.clone(),
        ],
        &[&[SWAP_SEED_PREFIX, &swap.swap_id, &[bump]]],
    )
}
