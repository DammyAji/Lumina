//! Hash Time-Locked Contract for the Solana leg of a Lumina cross-chain swap.
//!
//! A swap escrows SPL tokens in a vault owned by a per-swap PDA and can then go
//! exactly one of two ways:
//!
//! * the recipient reveals the preimage of the hashlock before `timeout_unix`
//!   and receives the tokens (`Claim`), or
//! * the timelock expires and the sender takes the tokens back (`Refund`).
//!
//! Both outcomes are terminal, so funds can never be locked indefinitely. The
//! preimage stored by `Claim` is what lets Lumina's coordinator settle the
//! Stellar leg of the same swap with the same secret.

pub mod error;
pub mod instruction;
pub mod logic;
pub mod processor;
pub mod state;

#[cfg(test)]
mod test;

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

#[cfg(not(feature = "no-entrypoint"))]
fn process_instruction(
    program_id: &solana_program::pubkey::Pubkey,
    accounts: &[solana_program::account_info::AccountInfo],
    instruction_data: &[u8],
) -> solana_program::entrypoint::ProgramResult {
    processor::process_instruction(program_id, accounts, instruction_data)
}
