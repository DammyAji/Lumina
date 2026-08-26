use solana_program::{program_error::ProgramError, pubkey::Pubkey};

use crate::error::HtlcError;

/// Lifecycle of a swap. Both `Claimed` and `Refunded` are terminal, so funds
/// are never locked indefinitely.
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum SwapStatus {
    Locked = 1,
    Claimed = 2,
    Refunded = 3,
}

impl SwapStatus {
    pub fn from_u8(value: u8) -> Result<Self, HtlcError> {
        match value {
            1 => Ok(SwapStatus::Locked),
            2 => Ok(SwapStatus::Claimed),
            3 => Ok(SwapStatus::Refunded),
            _ => Err(HtlcError::SwapNotFound),
        }
    }
}

/// On-chain layout of a swap account.
///
/// Serialised by hand rather than via Borsh so the layout is fixed-size and the
/// account rent is known up front: `LEN` bytes, every field at a stable offset.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HtlcSwap {
    pub swap_id: [u8; 32],
    pub sender: Pubkey,
    pub recipient: Pubkey,
    /// Token account the escrowed SPL tokens live in, owned by the swap PDA.
    pub vault: Pubkey,
    pub amount: u64,
    /// sha256(preimage). The same hash is used on every chain in the swap.
    pub secret_hash: [u8; 32],
    /// Unix timestamp at (or after) which `Refund` becomes callable.
    pub timeout_unix: i64,
    pub status: SwapStatus,
    /// Preimage revealed by `Claim`; all zeroes while the swap is locked.
    pub preimage: [u8; 32],
}

impl HtlcSwap {
    pub const LEN: usize = 32 + 32 + 32 + 32 + 8 + 32 + 8 + 1 + 32;

    pub fn pack(&self, dst: &mut [u8]) -> Result<(), ProgramError> {
        if dst.len() < Self::LEN {
            return Err(HtlcError::AccountDataTooSmall.into());
        }

        dst[0..32].copy_from_slice(&self.swap_id);
        dst[32..64].copy_from_slice(self.sender.as_ref());
        dst[64..96].copy_from_slice(self.recipient.as_ref());
        dst[96..128].copy_from_slice(self.vault.as_ref());
        dst[128..136].copy_from_slice(&self.amount.to_le_bytes());
        dst[136..168].copy_from_slice(&self.secret_hash);
        dst[168..176].copy_from_slice(&self.timeout_unix.to_le_bytes());
        dst[176] = self.status as u8;
        dst[177..209].copy_from_slice(&self.preimage);

        Ok(())
    }

    pub fn unpack(src: &[u8]) -> Result<Self, ProgramError> {
        if src.len() < Self::LEN {
            return Err(HtlcError::AccountDataTooSmall.into());
        }

        Ok(Self {
            swap_id: copy32(&src[0..32]),
            sender: Pubkey::new_from_array(copy32(&src[32..64])),
            recipient: Pubkey::new_from_array(copy32(&src[64..96])),
            vault: Pubkey::new_from_array(copy32(&src[96..128])),
            amount: u64::from_le_bytes(src[128..136].try_into().unwrap()),
            secret_hash: copy32(&src[136..168]),
            timeout_unix: i64::from_le_bytes(src[168..176].try_into().unwrap()),
            status: SwapStatus::from_u8(src[176])?,
            preimage: copy32(&src[177..209]),
        })
    }

    /// True when the account has never been written to by `Lock`.
    pub fn is_uninitialized(src: &[u8]) -> bool {
        src.len() < Self::LEN || src[176] == 0
    }
}

fn copy32(src: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    out.copy_from_slice(src);
    out
}
