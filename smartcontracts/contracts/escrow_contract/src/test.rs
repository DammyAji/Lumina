#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::{Address as _, Events}, Address, Env, IntoVal, FromVal, symbol_short, Vec};
use crate::types::{EscrowStatus, MilestoneStatus, DisputeStatus, DisputeDecision, ReleaseCondition};

#[test]
fn test_initialize() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, EscrowContract);
    let client = EscrowContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);

    client.initialize(&admin);

    let stored_admin = storage::get_admin(&env);
    assert_eq!(stored_admin, Some(admin));
}

#[test]
fn test_create_escrow() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, EscrowContract);
    let client = EscrowContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);

    client.initialize(&admin);

    let amount = 1000i128;
    let release_condition = symbol_short!("delivery");

    let escrow_id = client.create_escrow(&sender, &recipient, &amount, &release_condition);

    let escrow = client.get_escrow(&escrow_id).unwrap();
    assert_eq!(escrow.sender, sender);
    assert_eq!(escrow.recipient, recipient);
    assert_eq!(escrow.amount, amount);
    assert_eq!(escrow.status, EscrowStatus::Created);
}

#[test]
fn test_fund_escrow() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, EscrowContract);
    let client = EscrowContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);

    client.initialize(&admin);

    let amount = 1000i128;
    let release_condition = symbol_short!("delivery");
    let escrow_id = client.create_escrow(&sender, &recipient, &amount, &release_condition);

    client.fund_escrow(&escrow_id, &sender);

    let escrow = client.get_escrow(&escrow_id).unwrap();
    assert_eq!(escrow.status, EscrowStatus::Funded);
}

#[test]
fn test_release_escrow() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, EscrowContract);
    let client = EscrowContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);

    client.initialize(&admin);

    let amount = 1000i128;
    let release_condition = symbol_short!("delivery");
    let escrow_id = client.create_escrow(&sender, &recipient, &amount, &release_condition);

    client.fund_escrow(&escrow_id, &sender);

    client.release_escrow(&escrow_id, &admin);

    let escrow = client.get_escrow(&escrow_id).unwrap();
    assert_eq!(escrow.status, EscrowStatus::Released);
}

#[test]
fn test_refund_escrow() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, EscrowContract);
    let client = EscrowContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);

    client.initialize(&admin);

    let amount = 1000i128;
    let release_condition = symbol_short!("delivery");
    let escrow_id = client.create_escrow(&sender, &recipient, &amount, &release_condition);

    client.fund_escrow(&escrow_id, &sender);

    client.refund_escrow(&escrow_id, &sender);

    let escrow = client.get_escrow(&escrow_id).unwrap();
    assert_eq!(escrow.status, EscrowStatus::Refunded);
}

#[test]
fn test_cancel_escrow() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, EscrowContract);
    let client = EscrowContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);

    client.initialize(&admin);

    let amount = 1000i128;
    let release_condition = symbol_short!("delivery");
    let escrow_id = client.create_escrow(&sender, &recipient, &amount, &release_condition);

    client.cancel_escrow(&escrow_id, &sender);

    let escrow = client.get_escrow(&escrow_id).unwrap();
    assert_eq!(escrow.status, EscrowStatus::Cancelled);
}

#[test]
fn test_fund_unauthorized() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, EscrowContract);
    let client = EscrowContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let unauthorized = Address::generate(&env);

    client.initialize(&admin);

    let amount = 1000i128;
    let release_condition = symbol_short!("delivery");
    let escrow_id = client.create_escrow(&sender, &recipient, &amount, &release_condition);

    let result = client.try_fund_escrow(&escrow_id, &unauthorized);
    assert!(result.is_err());
}

#[test]
fn test_release_unauthorized() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, EscrowContract);
    let client = EscrowContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let unauthorized = Address::generate(&env);

    client.initialize(&admin);

    let amount = 1000i128;
    let release_condition = symbol_short!("delivery");
    let escrow_id = client.create_escrow(&sender, &recipient, &amount, &release_condition);

    client.fund_escrow(&escrow_id, &sender);

    let result = client.try_release_escrow(&escrow_id, &unauthorized);
    assert!(result.is_err());
}

#[test]
fn test_escrow_lifecycle() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, EscrowContract);
    let client = EscrowContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);

    client.initialize(&admin);

    let amount = 1000i128;
    let release_condition = symbol_short!("delivery");
    
    // Create
    let escrow_id = client.create_escrow(&sender, &recipient, &amount, &release_condition);
    let escrow = client.get_escrow(&escrow_id).unwrap();
    assert_eq!(escrow.status, EscrowStatus::Created);

    // Fund
    client.fund_escrow(&escrow_id, &sender);
    let escrow = client.get_escrow(&escrow_id).unwrap();
    assert_eq!(escrow.status, EscrowStatus::Funded);

    // Release
    client.release_escrow(&escrow_id, &admin);
    let escrow = client.get_escrow(&escrow_id).unwrap();
    assert_eq!(escrow.status, EscrowStatus::Released);
}

#[test]
fn test_create_multi_party_escrow() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, EscrowContract);
    let client = EscrowContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let party1 = Address::generate(&env);
    let party2 = Address::generate(&env);
    let party3 = Address::generate(&env);

    client.initialize(&admin);

    let mut parties = Vec::new(&env);
    parties.push_back(party1.clone());
    parties.push_back(party2.clone());
    parties.push_back(party3.clone());

    let mut amounts = Vec::new(&env);
    amounts.push_back(1000i128);
    amounts.push_back(2000i128);
    amounts.push_back(1500i128);

    let mut resolvers = Vec::new(&env);
    resolvers.push_back(admin.clone());
    resolvers.push_back(Address::generate(&env));

    let voting_threshold = 2u32;
    let timeout = env.ledger().timestamp() + 86400;

    let escrow_id = client.create_multi_party_escrow(&parties, &amounts, &resolvers, &voting_threshold, &timeout);

    let escrow = client.get_escrow(&escrow_id).unwrap();
    assert_eq!(escrow.is_multi_party, true);
    assert_eq!(escrow.parties.len(), 3);
    assert_eq!(escrow.voting_threshold, 2);
}

#[test]
fn test_add_milestone() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, EscrowContract);
    let client = EscrowContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let party1 = Address::generate(&env);
    let party2 = Address::generate(&env);
    let party3 = Address::generate(&env);

    client.initialize(&admin);

    let mut parties = Vec::new(&env);
    parties.push_back(party1.clone());
    parties.push_back(party2.clone());
    parties.push_back(party3.clone());

    let mut amounts = Vec::new(&env);
    amounts.push_back(1000i128);
    amounts.push_back(2000i128);
    amounts.push_back(1500i128);

    let mut resolvers = Vec::new(&env);
    resolvers.push_back(admin.clone());

    let voting_threshold = 1u32;
    let timeout = env.ledger().timestamp() + 86400;

    let escrow_id = client.create_multi_party_escrow(&parties, &amounts, &resolvers, &voting_threshold, &timeout);

    let description = String::from_str(&env, "First milestone");
    let milestone_id = 1u32;
    let amount = 500i128;
    let required_approvals = 2u32;
    let deadline = env.ledger().timestamp() + 3600;
    let beneficiary = party2.clone();

    client.add_milestone(&escrow_id, milestone_id, description, amount, required_approvals, deadline, beneficiary, party1);

    let milestone = client.get_milestone(&escrow_id, milestone_id).unwrap();
    assert_eq!(milestone.id, milestone_id);
    assert_eq!(milestone.status, MilestoneStatus::Pending);
    assert_eq!(milestone.required_approvals, 2);
}

#[test]
fn test_approve_milestone() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, EscrowContract);
    let client = EscrowContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let party1 = Address::generate(&env);
    let party2 = Address::generate(&env);
    let party3 = Address::generate(&env);

    client.initialize(&admin);

    let mut parties = Vec::new(&env);
    parties.push_back(party1.clone());
    parties.push_back(party2.clone());
    parties.push_back(party3.clone());

    let mut amounts = Vec::new(&env);
    amounts.push_back(1000i128);
    amounts.push_back(2000i128);
    amounts.push_back(1500i128);

    let mut resolvers = Vec::new(&env);
    resolvers.push_back(admin.clone());

    let voting_threshold = 1u32;
    let timeout = env.ledger().timestamp() + 86400;

    let escrow_id = client.create_multi_party_escrow(&parties, &amounts, &resolvers, &voting_threshold, &timeout);

    let description = String::from_str(&env, "First milestone");
    let milestone_id = 1u32;
    let amount = 500i128;
    let required_approvals = 2u32;
    let deadline = env.ledger().timestamp() + 3600;
    let beneficiary = party2.clone();

    client.add_milestone(&escrow_id, milestone_id, description, amount, required_approvals, deadline, beneficiary, party1);
    client.fund_escrow(&escrow_id, party1);

    client.approve_milestone(&escrow_id, milestone_id, party1);
    client.approve_milestone(&escrow_id, milestone_id, party2);

    let milestone = client.get_milestone(&escrow_id, milestone_id).unwrap();
    assert_eq!(milestone.status, MilestoneStatus::Approved);
}

#[test]
fn test_release_milestone() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, EscrowContract);
    let client = EscrowContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let party1 = Address::generate(&env);
    let party2 = Address::generate(&env);
    let party3 = Address::generate(&env);

    client.initialize(&admin);

    let mut parties = Vec::new(&env);
    parties.push_back(party1.clone());
    parties.push_back(party2.clone());
    parties.push_back(party3.clone());

    let mut amounts = Vec::new(&env);
    amounts.push_back(1000i128);
    amounts.push_back(2000i128);
    amounts.push_back(1500i128);

    let mut resolvers = Vec::new(&env);
    resolvers.push_back(admin.clone());

    let voting_threshold = 1u32;
    let timeout = env.ledger().timestamp() + 86400;

    let escrow_id = client.create_multi_party_escrow(&parties, &amounts, &resolvers, &voting_threshold, &timeout);

    let description = String::from_str(&env, "First milestone");
    let milestone_id = 1u32;
    let amount = 500i128;
    let required_approvals = 1u32;
    let deadline = env.ledger().timestamp() + 3600;
    let beneficiary = party2.clone();

    client.add_milestone(&escrow_id, milestone_id, description, amount, required_approvals, deadline, beneficiary, party1);
    client.fund_escrow(&escrow_id, party1);
    client.approve_milestone(&escrow_id, milestone_id, party1);

    client.release_milestone(&escrow_id, milestone_id, party2);

    let milestone = client.get_milestone(&escrow_id, milestone_id).unwrap();
    assert_eq!(milestone.status, MilestoneStatus::Released);
}

#[test]
fn test_raise_dispute() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, EscrowContract);
    let client = EscrowContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let party1 = Address::generate(&env);
    let party2 = Address::generate(&env);
    let party3 = Address::generate(&env);

    client.initialize(&admin);

    let mut parties = Vec::new(&env);
    parties.push_back(party1.clone());
    parties.push_back(party2.clone());
    parties.push_back(party3.clone());

    let mut amounts = Vec::new(&env);
    amounts.push_back(1000i128);
    amounts.push_back(2000i128);
    amounts.push_back(1500i128);

    let mut resolvers = Vec::new(&env);
    resolvers.push_back(admin.clone());

    let voting_threshold = 1u32;
    let timeout = env.ledger().timestamp() + 86400;

    let escrow_id = client.create_multi_party_escrow(&parties, &amounts, &resolvers, &voting_threshold, &timeout);
    client.fund_escrow(&escrow_id, party1);

    let reason = String::from_str(&env, "Work not completed");
    let dispute_id = 1u32;

    client.raise_dispute(&escrow_id, dispute_id, reason, party1, Some(1));

    let dispute = client.get_dispute(&escrow_id, dispute_id).unwrap();
    assert_eq!(dispute.status, DisputeStatus::Active);
    assert_eq!(dispute.raised_by, party1);

    let escrow = client.get_escrow(&escrow_id).unwrap();
    assert_eq!(escrow.status, EscrowStatus::Disputed);
}

#[test]
fn test_vote_on_dispute() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, EscrowContract);
    let client = EscrowContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let party1 = Address::generate(&env);
    let party2 = Address::generate(&env);
    let party3 = Address::generate(&env);

    client.initialize(&admin);

    let mut parties = Vec::new(&env);
    parties.push_back(party1.clone());
    parties.push_back(party2.clone());
    parties.push_back(party3.clone());

    let mut amounts = Vec::new(&env);
    amounts.push_back(1000i128);
    amounts.push_back(2000i128);
    amounts.push_back(1500i128);

    let mut resolvers = Vec::new(&env);
    resolvers.push_back(admin.clone());

    let voting_threshold = 1u32;
    let timeout = env.ledger().timestamp() + 86400;

    let escrow_id = client.create_multi_party_escrow(&parties, &amounts, &resolvers, &voting_threshold, &timeout);
    client.fund_escrow(&escrow_id, party1);

    let reason = String::from_str(&env, "Work not completed");
    let dispute_id = 1u32;

    client.raise_dispute(&escrow_id, dispute_id, reason, party1, Some(1));

    let decision = DisputeDecision::ReleaseToBeneficiary;
    client.vote_on_dispute(&escrow_id, dispute_id, decision, admin);

    let dispute = client.get_dispute(&escrow_id, dispute_id).unwrap();
    assert_eq!(dispute.status, DisputeStatus::Resolved);
    assert!(dispute.resolution.is_some());
}

#[test]
fn test_conditional_release_all_approve() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, EscrowContract);
    let client = EscrowContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let party1 = Address::generate(&env);
    let party2 = Address::generate(&env);
    let party3 = Address::generate(&env);

    client.initialize(&admin);

    let mut parties = Vec::new(&env);
    parties.push_back(party1.clone());
    parties.push_back(party2.clone());
    parties.push_back(party3.clone());

    let mut amounts = Vec::new(&env);
    amounts.push_back(1000i128);
    amounts.push_back(2000i128);
    amounts.push_back(1500i128);

    let mut resolvers = Vec::new(&env);
    resolvers.push_back(admin.clone());

    let voting_threshold = 1u32;
    let timeout = env.ledger().timestamp() + 86400;

    let escrow_id = client.create_multi_party_escrow(&parties, &amounts, &resolvers, &voting_threshold, &timeout);
    client.fund_escrow(&escrow_id, party1);

    let mut approvers = Vec::new(&env);
    approvers.push_back(party1.clone());
    approvers.push_back(party2.clone());

    let condition = ReleaseCondition::AllApprove(approvers);
    client.conditional_release(&escrow_id, condition, party1);

    let escrow = client.get_escrow(&escrow_id).unwrap();
    assert_eq!(escrow.status, EscrowStatus::Released);
}

#[test]
fn test_claim_timeout_release() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, EscrowContract);
    let client = EscrowContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let party1 = Address::generate(&env);
    let party2 = Address::generate(&env);

    client.initialize(&admin);

    let amount = 1000i128;
    let release_condition = symbol_short!("delivery");
    let escrow_id = client.create_escrow(&party1, party2, amount, release_condition);
    client.fund_escrow(&escrow_id, party1);

    // Advance time past timeout
    env.ledger().set_timestamp(env.ledger().timestamp() + 2600000);

    client.claim_timeout_release(&escrow_id, party1);

    let escrow = client.get_escrow(&escrow_id).unwrap();
    assert_eq!(escrow.status, EscrowStatus::Refunded);
}
