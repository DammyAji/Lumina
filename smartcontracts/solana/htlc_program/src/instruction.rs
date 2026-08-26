use solana_program::{program_error::ProgramError, pubkey::Pubkey};

use crate::error::HtlcError;

/// Instructions accepted by the Lumina HTLC program.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HtlcInstruction {
    /// Escrow `amount` SPL tokens under `secret_hash` until `timeout_unix`.
    ///
    /// Accounts:
    /// 0. `[signer]`   sender
    /// 1. `[writable]` swap state account (PDA of `[b"swap", swap_id]`)
    /// 2. `[writable]` sender's token account
    /// 3. `[writable]` vault token account, owned by the swap PDA
    /// 4. `[]`         SPL token program
    Lock {
        swap_id: [u8; 32],
        recipient: Pubkey,
        amount: u64,
        secret_hash: [u8; 32],
        timeout_unix: i64,
    },

    /// Release the escrow to the recipient by revealing the hashlock preimage.
    ///
    /// Accounts:
    /// 0. `[signer]`   recipient
    /// 1. `[writable]` swap state account
    /// 2. `[writable]` vault token account
    /// 3. `[writable]` recipient's token account
    /// 4. `[]`         SPL token program
    Claim { preimage: [u8; 32] },

    /// Return the escrow to the sender once the timelock has expired.
    ///
    /// Accounts:
    /// 0. `[signer]`   sender
    /// 1. `[writable]` swap state account
    /// 2. `[writable]` vault token account
    /// 3. `[writable]` sender's token account
    /// 4. `[]`         SPL token program
    Refund,
}

impl HtlcInstruction {
    pub fn pack(&self) -> Vec<u8> {
        match self {
            HtlcInstruction::Lock {
                swap_id,
                recipient,
                amount,
                secret_hash,
                timeout_unix,
            } => {
                let mut buf = Vec::with_capacity(1 + 32 + 32 + 8 + 32 + 8);
                buf.push(0);
                buf.extend_from_slice(swap_id);
                buf.extend_from_slice(recipient.as_ref());
                buf.extend_from_slice(&amount.to_le_bytes());
                buf.extend_from_slice(secret_hash);
                buf.extend_from_slice(&timeout_unix.to_le_bytes());
                buf
            }
            HtlcInstruction::Claim { preimage } => {
                let mut buf = Vec::with_capacity(1 + 32);
                buf.push(1);
                buf.extend_from_slice(preimage);
                buf
            }
            HtlcInstruction::Refund => vec![2],
        }
    }

    pub fn unpack(input: &[u8]) -> Result<Self, ProgramError> {
        let (tag, rest) = input.split_first().ok_or(HtlcError::InvalidInstruction)?;

        match tag {
            0 => {
                if rest.len() < 112 {
                    return Err(HtlcError::InvalidInstruction.into());
                }

                Ok(HtlcInstruction::Lock {
                    swap_id: take32(&rest[0..32]),
                    recipient: Pubkey::new_from_array(take32(&rest[32..64])),
                    amount: u64::from_le_bytes(rest[64..72].try_into().unwrap()),
                    secret_hash: take32(&rest[72..104]),
                    timeout_unix: i64::from_le_bytes(rest[104..112].try_into().unwrap()),
                })
            }
            1 => {
                if rest.len() < 32 {
                    return Err(HtlcError::InvalidInstruction.into());
                }

                Ok(HtlcInstruction::Claim {
                    preimage: take32(&rest[0..32]),
                })
            }
            2 => Ok(HtlcInstruction::Refund),
            _ => Err(HtlcError::InvalidInstruction.into()),
        }
    }
}

fn take32(src: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    out.copy_from_slice(src);
    out
}
