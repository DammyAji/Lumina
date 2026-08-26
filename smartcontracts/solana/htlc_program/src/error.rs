use solana_program::program_error::ProgramError;

/// Errors returned by the Lumina HTLC program.
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum HtlcError {
    SwapAlreadyExists = 0,
    SwapNotFound = 1,
    InvalidAmount = 2,
    InvalidTimeout = 3,
    SwapNotLocked = 4,
    InvalidPreimage = 5,
    TimelockExpired = 6,
    TimelockNotExpired = 7,
    InvalidRecipient = 8,
    InvalidInstruction = 9,
    AccountDataTooSmall = 10,
}

impl From<HtlcError> for ProgramError {
    fn from(error: HtlcError) -> Self {
        ProgramError::Custom(error as u32)
    }
}
