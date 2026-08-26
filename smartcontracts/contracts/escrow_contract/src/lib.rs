#![no_std]

use soroban_sdk::{contract, contractimpl, Env, Address, String, Symbol, Vec};

mod logic;
mod storage;
mod types;

use storage;

#[contract]
pub struct EscrowContract;

#[contractimpl]
impl EscrowContract {
    pub fn initialize(env: Env, admin: Address) {
        logic::initialize(&env, admin);
    }

    pub fn create_escrow(
        env: Env,
        sender: Address,
        recipient: Address,
        amount: i128,
        release_condition: Symbol,
    ) -> Result<String, crate::types::Error> {
        logic::create_escrow(&env, sender, recipient, amount, release_condition)
    }

    pub fn create_multi_party_escrow(
        env: Env,
        parties: Vec<Address>,
        amounts: Vec<i128>,
        dispute_resolvers: Vec<Address>,
        voting_threshold: u32,
        timeout: u64,
    ) -> Result<String, crate::types::Error> {
        logic::create_multi_party_escrow(&env, parties, amounts, dispute_resolvers, voting_threshold, timeout)
    }

    pub fn fund_escrow(env: Env, escrow_id: String, funder: Address) -> Result<(), crate::types::Error> {
        logic::fund_escrow(&env, escrow_id, funder)
    }

    pub fn release_escrow(env: Env, escrow_id: String, admin: Address) -> Result<(), crate::types::Error> {
        logic::release_escrow(&env, escrow_id, admin)
    }

    pub fn refund_escrow(env: Env, escrow_id: String, requester: Address) -> Result<(), crate::types::Error> {
        logic::refund_escrow(&env, escrow_id, requester)
    }

    pub fn cancel_escrow(env: Env, escrow_id: String, requester: Address) -> Result<(), crate::types::Error> {
        logic::cancel_escrow(&env, escrow_id, requester)
    }

    pub fn add_milestone(
        env: Env,
        escrow_id: String,
        milestone_id: u32,
        description: String,
        amount: i128,
        required_approvals: u32,
        deadline: u64,
        beneficiary: Address,
        creator: Address,
    ) -> Result<(), crate::types::Error> {
        logic::add_milestone(&env, escrow_id, milestone_id, description, amount, required_approvals, deadline, beneficiary, creator)
    }

    pub fn approve_milestone(
        env: Env,
        escrow_id: String,
        milestone_id: u32,
        approver: Address,
    ) -> Result<(), crate::types::Error> {
        logic::approve_milestone(&env, escrow_id, milestone_id, approver)
    }

    pub fn release_milestone(
        env: Env,
        escrow_id: String,
        milestone_id: u32,
        requester: Address,
    ) -> Result<(), crate::types::Error> {
        logic::release_milestone(&env, escrow_id, milestone_id, requester)
    }

    pub fn raise_dispute(
        env: Env,
        escrow_id: String,
        dispute_id: u32,
        reason: String,
        raiser: Address,
        milestone_id: Option<u32>,
    ) -> Result<(), crate::types::Error> {
        logic::raise_dispute(&env, escrow_id, dispute_id, reason, raiser, milestone_id)
    }

    pub fn vote_on_dispute(
        env: Env,
        escrow_id: String,
        dispute_id: u32,
        decision: crate::types::DisputeDecision,
        voter: Address,
    ) -> Result<(), crate::types::Error> {
        logic::vote_on_dispute(&env, escrow_id, dispute_id, decision, voter)
    }

    pub fn execute_dispute_resolution(
        env: Env,
        escrow_id: String,
        dispute_id: u32,
        executor: Address,
    ) -> Result<(), crate::types::Error> {
        logic::execute_dispute_resolution(&env, escrow_id, dispute_id, executor)
    }

    pub fn conditional_release(
        env: Env,
        escrow_id: String,
        condition: crate::types::ReleaseCondition,
        requester: Address,
    ) -> Result<(), crate::types::Error> {
        logic::conditional_release(&env, escrow_id, condition, requester)
    }

    pub fn claim_timeout_release(
        env: Env,
        escrow_id: String,
        requester: Address,
    ) -> Result<(), crate::types::Error> {
        logic::claim_timeout_release(&env, escrow_id, requester)
    }

    pub fn get_escrow(env: Env, escrow_id: String) -> Option<crate::types::Escrow> {
        storage::get_escrow(&env, escrow_id)
    }

    pub fn get_milestone(env: Env, escrow_id: String, milestone_id: u32) -> Option<crate::types::Milestone> {
        storage::get_milestone(&env, escrow_id, milestone_id)
    }

    pub fn get_dispute(env: Env, escrow_id: String, dispute_id: u32) -> Option<crate::types::Dispute> {
        storage::get_dispute(&env, escrow_id, dispute_id)
    }
}
