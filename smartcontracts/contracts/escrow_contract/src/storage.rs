use soroban_sdk::{Env, Address, String};
use crate::types::{DataKey, Escrow, Milestone, Dispute};

pub fn get_admin(env: &Env) -> Option<Address> {
    env.storage().instance().get::<DataKey, Address>(&DataKey::EscrowAdmin)
}

pub fn set_admin(env: &Env, admin: &Address) {
    env.storage().instance().set::<DataKey, Address>(&DataKey::EscrowAdmin, admin);
}

pub fn save_escrow(env: &Env, escrow_id: String, escrow: Escrow) {
    env.storage().instance().set::<DataKey, Escrow>(&DataKey::Escrow(escrow_id), &escrow);
}

pub fn get_escrow(env: &Env, escrow_id: String) -> Option<Escrow> {
    env.storage().instance().get::<DataKey, Escrow>(&DataKey::Escrow(escrow_id))
}

pub fn escrow_exists(env: &Env, escrow_id: String) -> bool {
    env.storage().instance().has(&DataKey::Escrow(escrow_id))
}

pub fn save_milestone(env: &Env, escrow_id: String, milestone_id: u32, milestone: Milestone) {
    env.storage().instance().set::<DataKey, Milestone>(&DataKey::Milestone(escrow_id, milestone_id), &milestone);
}

pub fn get_milestone(env: &Env, escrow_id: String, milestone_id: u32) -> Option<Milestone> {
    env.storage().instance().get::<DataKey, Milestone>(&DataKey::Milestone(escrow_id, milestone_id))
}

pub fn milestone_exists(env: &Env, escrow_id: String, milestone_id: u32) -> bool {
    env.storage().instance().has(&DataKey::Milestone(escrow_id, milestone_id))
}

pub fn save_dispute(env: &Env, escrow_id: String, dispute_id: u32, dispute: Dispute) {
    env.storage().instance().set::<DataKey, Dispute>(&DataKey::Dispute(escrow_id, dispute_id), &dispute);
}

pub fn get_dispute(env: &Env, escrow_id: String, dispute_id: u32) -> Option<Dispute> {
    env.storage().instance().get::<DataKey, Dispute>(&DataKey::Dispute(escrow_id, dispute_id))
}

pub fn dispute_exists(env: &Env, escrow_id: String, dispute_id: u32) -> bool {
    env.storage().instance().has(&DataKey::Dispute(escrow_id, dispute_id))
}

pub fn get_escrow_counter(env: &Env) -> u32 {
    env.storage().instance().get::<DataKey, u32>(&DataKey::EscrowCounter).unwrap_or(0)
}

pub fn increment_escrow_counter(env: &Env) -> u32 {
    let counter = get_escrow_counter(env) + 1;
    env.storage().instance().set::<DataKey, u32>(&DataKey::EscrowCounter, &counter);
    counter
}
