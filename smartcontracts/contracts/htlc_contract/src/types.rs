use soroban_sdk::{contracterror, contracttype, Address, BytesN};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    /// A locked swap, keyed by its 32-byte swap id.
    Swap(BytesN<32>),
    /// The revealed preimage for a claimed swap. Kept under its own key so the
    /// counterparty chain's listener can read it without decoding the whole swap.
    Preimage(BytesN<32>),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SwapStatus {
    /// Funds are held by the contract, awaiting a claim or a refund.
    Locked,
    /// The recipient revealed the preimage and took the funds.
    Claimed,
    /// The timelock expired and the sender took the funds back.
    Refunded,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Swap {
    pub swap_id: BytesN<32>,
    pub sender: Address,
    pub recipient: Address,
    pub token: Address,
    pub amount: i128,
    /// sha256(preimage). The same hash is used on every chain in the swap.
    pub secret_hash: BytesN<32>,
    /// Ledger sequence at (or after) which `refund` becomes callable.
    pub timeout_ledger: u32,
    pub status: SwapStatus,
    pub created_at: u64,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum Error {
    SwapAlreadyExists = 1,
    SwapNotFound = 2,
    InvalidAmount = 3,
    InvalidTimeout = 4,
    SwapNotLocked = 5,
    InvalidPreimage = 6,
    TimelockNotExpired = 7,
    TimelockExpired = 8,
    SameSenderAndRecipient = 9,
}
