use soroban_sdk::{contracttype, contracterror, Address, String, Symbol, Vec, Map};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    EscrowAdmin,
    Escrow(String),
    Milestone(String, u32),
    Dispute(String, u32),
    EscrowCounter,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EscrowStatus {
    Created,
    Funded,
    Released,
    Refunded,
    Cancelled,
    Disputed,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Escrow {
    pub escrow_id: String,
    pub parties: Vec<Address>,
    pub amounts: Vec<i128>,
    pub status: EscrowStatus,
    pub created_at: u64,
    pub timeout: u64,
    pub dispute_resolvers: Vec<Address>,
    pub voting_threshold: u32,
    pub is_multi_party: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MilestoneStatus {
    Pending,
    Approved,
    Released,
    Rejected,
    Expired,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Milestone {
    pub id: u32,
    pub description: String,
    pub amount: i128,
    pub required_approvals: u32,
    pub approvals: Vec<Address>,
    pub status: MilestoneStatus,
    pub deadline: u64,
    pub beneficiary: Address,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DisputeStatus {
    Active,
    Resolved,
    Rejected,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DisputeDecision {
    ReleaseToBeneficiary,
    RefundToSender,
    Split(Vec<Address>, Vec<i128>),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Vote {
    pub voter: Address,
    pub decision: DisputeDecision,
    pub voted_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Dispute {
    pub id: u32,
    pub reason: String,
    pub raised_by: Address,
    pub raised_at: u64,
    pub votes: Vec<Vote>,
    pub resolution: Option<DisputeDecision>,
    pub status: DisputeStatus,
    pub milestone_id: Option<u32>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ReleaseCondition {
    AllApprove(Vec<Address>),
    AnyApprove(Vec<Address>),
    ThresholdApprove(Vec<Address>, u32),
    TimeLock(u64),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum Error {
    NotAuthorized = 1,
    EscrowNotFound = 2,
    InvalidStatus = 3,
    InsufficientBalance = 4,
    InvalidMilestone = 5,
    InvalidDispute = 6,
    VotingThresholdNotMet = 7,
    MilestoneDeadlinePassed = 8,
    DisputeAlreadyActive = 9,
    InvalidParty = 10,
    InvalidAmount = 11,
    TimeoutNotReached = 12,
}
