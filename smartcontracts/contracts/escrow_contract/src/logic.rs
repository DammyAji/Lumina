use soroban_sdk::{Env, Address, String, Symbol, symbol_short, xdr::ToXdr, Vec};
use crate::storage;
use crate::types::{Error, Escrow, EscrowStatus, Milestone, MilestoneStatus, Dispute, DisputeStatus, DisputeDecision, Vote, ReleaseCondition};

pub fn initialize(env: &Env, admin: Address) {
    if storage::get_admin(env).is_none() {
        storage::set_admin(env, &admin);
    }
}

fn generate_escrow_id(env: &Env, parties: &Vec<Address>) -> String {
    let timestamp = env.ledger().timestamp();
    let counter = storage::increment_escrow_counter(env);
    let tuple = (parties.clone(), timestamp, counter);
    let hash = env.crypto().sha256(&tuple.to_xdr(env));
    
    let hex_chars = b"0123456789abcdef";
    let mut hex_bytes = [0u8; 64];
    for (i, &b) in hash.to_array().iter().enumerate() {
        hex_bytes[i * 2] = hex_chars[(b >> 4) as usize];
        hex_bytes[i * 2 + 1] = hex_chars[(b & 0x0F) as usize];
    }
    String::from_str(env, core::str::from_utf8(&hex_bytes).unwrap())
}

pub fn create_escrow(
    env: &Env,
    sender: Address,
    recipient: Address,
    amount: i128,
    release_condition: Symbol,
) -> Result<String, Error> {
    sender.require_auth();
    
    let mut parties = Vec::new(env);
    parties.push_back(sender.clone());
    parties.push_back(recipient.clone());
    
    let mut amounts = Vec::new(env);
    amounts.push_back(amount);
    
    let escrow_id = generate_escrow_id(env, &parties);
    
    if storage::escrow_exists(env, escrow_id.clone()) {
        return Err(Error::EscrowNotFound);
    }
    
    let escrow = Escrow {
        escrow_id: escrow_id.clone(),
        parties,
        amounts,
        status: EscrowStatus::Created,
        created_at: env.ledger().timestamp(),
        timeout: env.ledger().timestamp() + 2592000, // 30 days default
        dispute_resolvers: Vec::new(env),
        voting_threshold: 1,
        is_multi_party: false,
    };
    
    storage::save_escrow(env, escrow_id.clone(), escrow);
    
    env.events().publish(
        (symbol_short!("escr_new"), escrow_id.clone()),
        sender
    );
    
    Ok(escrow_id)
}

pub fn create_multi_party_escrow(
    env: &Env,
    parties: Vec<Address>,
    amounts: Vec<i128>,
    dispute_resolvers: Vec<Address>,
    voting_threshold: u32,
    timeout: u64,
) -> Result<String, Error> {
    if parties.len() < 3 {
        return Err(Error::InvalidParty);
    }
    
    if parties.len() != amounts.len() {
        return Err(Error::InvalidAmount);
    }
    
    if voting_threshold == 0 || voting_threshold > dispute_resolvers.len() as u32 {
        return Err(Error::VotingThresholdNotMet);
    }
    
    let first_party = parties.get(0).unwrap();
    first_party.require_auth();
    
    let escrow_id = generate_escrow_id(env, &parties);
    
    if storage::escrow_exists(env, escrow_id.clone()) {
        return Err(Error::EscrowNotFound);
    }
    
    let escrow = Escrow {
        escrow_id: escrow_id.clone(),
        parties,
        amounts,
        status: EscrowStatus::Created,
        created_at: env.ledger().timestamp(),
        timeout,
        dispute_resolvers,
        voting_threshold,
        is_multi_party: true,
    };
    
    storage::save_escrow(env, escrow_id.clone(), escrow);
    
    env.events().publish(
        (symbol_short!("mul_escr"), escrow_id.clone()),
        first_party
    );
    
    Ok(escrow_id)
}

pub fn fund_escrow(env: &Env, escrow_id: String, funder: Address) -> Result<(), Error> {
    funder.require_auth();
    
    let mut escrow = storage::get_escrow(env, escrow_id.clone())
        .ok_or(Error::EscrowNotFound)?;
    
    // Check if funder is a party in the escrow
    let mut is_party = false;
    let mut i = 0;
    while i < escrow.parties.len() {
        let party = escrow.parties.get(i).unwrap();
        if party.eq(&funder) {
            is_party = true;
            break;
        }
        i += 1;
    }
    if !is_party {
        return Err(Error::NotAuthorized);
    }
    
    if escrow.status != EscrowStatus::Created {
        return Err(Error::InvalidStatus);
    }
    
    escrow.status = EscrowStatus::Funded;
    storage::save_escrow(env, escrow_id, escrow);
    
    env.events().publish(
        (symbol_short!("escr_fund"), escrow_id.clone()),
        funder
    );
    
    Ok(())
}

pub fn release_escrow(env: &Env, escrow_id: String, admin: Address) -> Result<(), Error> {
    admin.require_auth();
    
    let admin_check = storage::get_admin(env).ok_or(Error::NotAuthorized)?;
    if admin_check != admin {
        return Err(Error::NotAuthorized);
    }
    
    let mut escrow = storage::get_escrow(env, escrow_id.clone())
        .ok_or(Error::EscrowNotFound)?;
    
    if escrow.status != EscrowStatus::Funded {
        return Err(Error::InvalidStatus);
    }
    
    escrow.status = EscrowStatus::Released;
    storage::save_escrow(env, escrow_id, escrow);
    
    Ok(())
}

pub fn refund_escrow(env: &Env, escrow_id: String, requester: Address) -> Result<(), Error> {
    requester.require_auth();
    
    let mut escrow = storage::get_escrow(env, escrow_id.clone())
        .ok_or(Error::EscrowNotFound)?;
    
    // Check if requester is a party in the escrow
    let mut is_party = false;
    let mut i = 0;
    while i < escrow.parties.len() {
        let party = escrow.parties.get(i).unwrap();
        if party.eq(&requester) {
            is_party = true;
            break;
        }
        i += 1;
    }
    if !is_party {
        return Err(Error::NotAuthorized);
    }
    
    if escrow.status != EscrowStatus::Funded {
        return Err(Error::InvalidStatus);
    }
    
    escrow.status = EscrowStatus::Refunded;
    storage::save_escrow(env, escrow_id, escrow);
    
    env.events().publish(
        (symbol_short!("escr_ref"), escrow_id.clone()),
        requester
    );
    
    Ok(())
}

pub fn cancel_escrow(env: &Env, escrow_id: String, requester: Address) -> Result<(), Error> {
    requester.require_auth();
    
    let mut escrow = storage::get_escrow(env, escrow_id.clone())
        .ok_or(Error::EscrowNotFound)?;
    
    // Check if requester is a party in the escrow
    let mut is_party = false;
    let mut i = 0;
    while i < escrow.parties.len() {
        let party = escrow.parties.get(i).unwrap();
        if party.eq(&requester) {
            is_party = true;
            break;
        }
        i += 1;
    }
    if !is_party {
        return Err(Error::NotAuthorized);
    }
    
    if escrow.status != EscrowStatus::Created {
        return Err(Error::InvalidStatus);
    }
    
    escrow.status = EscrowStatus::Cancelled;
    storage::save_escrow(env, escrow_id, escrow);
    
    env.events().publish(
        (symbol_short!("escr_can"), escrow_id.clone()),
        requester
    );
    
    Ok(())
}

// Milestone management functions
pub fn add_milestone(
    env: &Env,
    escrow_id: String,
    milestone_id: u32,
    description: String,
    amount: i128,
    required_approvals: u32,
    deadline: u64,
    beneficiary: Address,
    creator: Address,
) -> Result<(), Error> {
    creator.require_auth();
    
    let escrow = storage::get_escrow(env, escrow_id.clone())
        .ok_or(Error::EscrowNotFound)?;
    
    if !escrow.is_multi_party {
        return Err(Error::InvalidMilestone);
    }
    
    // Check if creator is a party in the escrow
    let mut is_party = false;
    let mut i = 0;
    while i < escrow.parties.len() {
        let party = escrow.parties.get(i).unwrap();
        if party.eq(&creator) {
            is_party = true;
            break;
        }
        i += 1;
    }
    if !is_party {
        return Err(Error::NotAuthorized);
    }
    
    if storage::milestone_exists(env, escrow_id.clone(), milestone_id) {
        return Err(Error::InvalidMilestone);
    }
    
    if deadline > escrow.timeout {
        return Err(Error::MilestoneDeadlinePassed);
    }
    
    let milestone = Milestone {
        id: milestone_id,
        description,
        amount,
        required_approvals,
        approvals: Vec::new(env),
        status: MilestoneStatus::Pending,
        deadline,
        beneficiary,
    };
    
    storage::save_milestone(env, escrow_id, milestone_id, milestone);
    
    env.events().publish(
        (symbol_short!("mst_add"), milestone_id),
        creator
    );
    
    Ok(())
}

pub fn approve_milestone(
    env: &Env,
    escrow_id: String,
    milestone_id: u32,
    approver: Address,
) -> Result<(), Error> {
    approver.require_auth();
    
    let escrow = storage::get_escrow(env, escrow_id.clone())
        .ok_or(Error::EscrowNotFound)?;
    
    if escrow.status != EscrowStatus::Funded {
        return Err(Error::InvalidStatus);
    }
    
    let mut milestone = storage::get_milestone(env, escrow_id.clone(), milestone_id)
        .ok_or(Error::InvalidMilestone)?;
    
    if milestone.status != MilestoneStatus::Pending {
        return Err(Error::InvalidMilestone);
    }
    
    // Check if approver is a party in the escrow
    let mut is_party = false;
    let mut i = 0;
    while i < escrow.parties.len() {
        let party = escrow.parties.get(i).unwrap();
        if party.eq(&approver) {
            is_party = true;
            break;
        }
        i += 1;
    }
    if !is_party {
        return Err(Error::NotAuthorized);
    }
    
    // Check if already approved
    let mut already_approved = false;
    let mut j = 0;
    while j < milestone.approvals.len() {
        let approver_addr = milestone.approvals.get(j).unwrap();
        if approver_addr.eq(&approver) {
            already_approved = true;
            break;
        }
        j += 1;
    }
    if already_approved {
        return Err(Error::NotAuthorized);
    }
    
    milestone.approvals.push_back(approver);
    
    // Check if threshold met
    if milestone.approvals.len() >= milestone.required_approvals as u32 {
        milestone.status = MilestoneStatus::Approved;
    }
    
    storage::save_milestone(env, escrow_id, milestone_id, milestone);
    
    env.events().publish(
        (symbol_short!("mst_app"), milestone_id),
        approver
    );
    
    Ok(())
}

pub fn release_milestone(
    env: &Env,
    escrow_id: String,
    milestone_id: u32,
    requester: Address,
) -> Result<(), Error> {
    requester.require_auth();
    
    let escrow = storage::get_escrow(env, escrow_id.clone())
        .ok_or(Error::EscrowNotFound)?;
    
    if escrow.status != EscrowStatus::Funded {
        return Err(Error::InvalidStatus);
    }
    
    let mut milestone = storage::get_milestone(env, escrow_id.clone(), milestone_id)
        .ok_or(Error::InvalidMilestone)?;
    
    if milestone.status != MilestoneStatus::Approved {
        return Err(Error::InvalidMilestone);
    }
    
    // Check if requester is the beneficiary
    if !milestone.beneficiary.eq(&requester) {
        return Err(Error::NotAuthorized);
    }
    
    milestone.status = MilestoneStatus::Released;
    storage::save_milestone(env, escrow_id, milestone_id, milestone);
    
    env.events().publish(
        (symbol_short!("mst_rel"), milestone_id),
        requester
    );
    
    Ok(())
}

// Dispute resolution functions
pub fn raise_dispute(
    env: &Env,
    escrow_id: String,
    dispute_id: u32,
    reason: String,
    raiser: Address,
    milestone_id: Option<u32>,
) -> Result<(), Error> {
    raiser.require_auth();
    
    let mut escrow = storage::get_escrow(env, escrow_id.clone())
        .ok_or(Error::EscrowNotFound)?;
    
    if escrow.status != EscrowStatus::Funded {
        return Err(Error::InvalidStatus);
    }
    
    // Check if raiser is a party in the escrow
    let mut is_party = false;
    let mut i = 0;
    while i < escrow.parties.len() {
        let party = escrow.parties.get(i).unwrap();
        if party.eq(&raiser) {
            is_party = true;
            break;
        }
        i += 1;
    }
    if !is_party {
        return Err(Error::NotAuthorized);
    }
    
    if storage::dispute_exists(env, escrow_id.clone(), dispute_id) {
        return Err(Error::InvalidDispute);
    }
    
    // Check if there's an active dispute for this milestone or escrow-wide
    if milestone_id.is_some() {
        let mid = milestone_id.unwrap();
        let mut i = 0;
        let mut has_active = false;
        while i < 100 { // reasonable limit
            if storage::dispute_exists(env, escrow_id.clone(), i) {
                let dispute = storage::get_dispute(env, escrow_id.clone(), i).unwrap();
                if dispute.status == DisputeStatus::Active && dispute.milestone_id == milestone_id {
                    has_active = true;
                    break;
                }
            }
            i += 1;
        }
        if has_active {
            return Err(Error::DisputeAlreadyActive);
        }
    }
    
    escrow.status = EscrowStatus::Disputed;
    storage::save_escrow(env, escrow_id.clone(), escrow);
    
    let dispute = Dispute {
        id: dispute_id,
        reason,
        raised_by: raiser.clone(),
        raised_at: env.ledger().timestamp(),
        votes: Vec::new(env),
        resolution: None,
        status: DisputeStatus::Active,
        milestone_id,
    };
    
    storage::save_dispute(env, escrow_id, dispute_id, dispute);
    
    env.events().publish(
        (symbol_short!("disp_rse"), dispute_id),
        raiser
    );
    
    Ok(())
}

pub fn vote_on_dispute(
    env: &Env,
    escrow_id: String,
    dispute_id: u32,
    decision: DisputeDecision,
    voter: Address,
) -> Result<(), Error> {
    voter.require_auth();
    
    let escrow = storage::get_escrow(env, escrow_id.clone())
        .ok_or(Error::EscrowNotFound)?;
    
    // Check if voter is a dispute resolver
    let mut is_resolver = false;
    let mut i = 0;
    while i < escrow.dispute_resolvers.len() {
        let resolver = escrow.dispute_resolvers.get(i).unwrap();
        if resolver.eq(&voter) {
            is_resolver = true;
            break;
        }
        i += 1;
    }
    if !is_resolver {
        return Err(Error::NotAuthorized);
    }
    
    let mut dispute = storage::get_dispute(env, escrow_id.clone(), dispute_id)
        .ok_or(Error::InvalidDispute)?;
    
    if dispute.status != DisputeStatus::Active {
        return Err(Error::InvalidDispute);
    }
    
    // Check if already voted
    let mut already_voted = false;
    let mut j = 0;
    while j < dispute.votes.len() {
        let vote = dispute.votes.get(j).unwrap();
        if vote.voter.eq(&voter) {
            already_voted = true;
            break;
        }
        j += 1;
    }
    if already_voted {
        return Err(Error::NotAuthorized);
    }
    
    let vote = Vote {
        voter: voter.clone(),
        decision: decision.clone(),
        voted_at: env.ledger().timestamp(),
    };
    
    dispute.votes.push_back(vote);
    
    // Check if voting threshold met
    if dispute.votes.len() >= escrow.voting_threshold as u32 {
        // Simple majority: count decision types
        let mut release_count = 0u32;
        let mut refund_count = 0u32;
        let mut split_count = 0u32;
        
        let mut k = 0;
        while k < dispute.votes.len() {
            let vote = dispute.votes.get(k).unwrap();
            match vote.decision {
                DisputeDecision::ReleaseToBeneficiary => release_count += 1,
                DisputeDecision::RefundToSender => refund_count += 1,
                DisputeDecision::Split(_, _) => split_count += 1,
            }
            k += 1;
        }
        
        let threshold = (dispute.votes.len() as u32) / 2 + 1;
        
        if release_count >= threshold {
            dispute.resolution = Some(DisputeDecision::ReleaseToBeneficiary);
            dispute.status = DisputeStatus::Resolved;
        } else if refund_count >= threshold {
            dispute.resolution = Some(DisputeDecision::RefundToSender);
            dispute.status = DisputeStatus::Resolved;
        } else if split_count >= threshold {
            // For simplicity, use first split decision
            let mut k = 0;
            while k < dispute.votes.len() {
                let vote = dispute.votes.get(k).unwrap();
                if let DisputeDecision::Split(ref addrs, ref amts) = vote.decision {
                    dispute.resolution = Some(DisputeDecision::Split(addrs.clone(), amts.clone()));
                    dispute.status = DisputeStatus::Resolved;
                    break;
                }
                k += 1;
            }
        }
    }
    
    storage::save_dispute(env, escrow_id, dispute_id, dispute);
    
    env.events().publish(
        (symbol_short!("disp_vote"), dispute_id),
        voter
    );
    
    Ok(())
}

pub fn execute_dispute_resolution(
    env: &Env,
    escrow_id: String,
    dispute_id: u32,
    executor: Address,
) -> Result<(), Error> {
    executor.require_auth();
    
    let mut escrow = storage::get_escrow(env, escrow_id.clone())
        .ok_or(Error::EscrowNotFound)?;
    
    let dispute = storage::get_dispute(env, escrow_id.clone(), dispute_id)
        .ok_or(Error::InvalidDispute)?;
    
    if dispute.status != DisputeStatus::Resolved {
        return Err(Error::InvalidDispute);
    }
    
    // Check if executor is a dispute resolver
    let mut is_resolver = false;
    let mut i = 0;
    while i < escrow.dispute_resolvers.len() {
        let resolver = escrow.dispute_resolvers.get(i).unwrap();
        if resolver.eq(&executor) {
            is_resolver = true;
            break;
        }
        i += 1;
    }
    if !is_resolver {
        return Err(Error::NotAuthorized);
    }
    
    let resolution = dispute.resolution.ok_or(Error::InvalidDispute)?;
    
    match resolution {
        DisputeDecision::ReleaseToBeneficiary => {
            if let Some(mid) = dispute.milestone_id {
                let mut milestone = storage::get_milestone(env, escrow_id.clone(), mid)
                    .ok_or(Error::InvalidMilestone)?;
                milestone.status = MilestoneStatus::Released;
                storage::save_milestone(env, escrow_id, mid, milestone);
            } else {
                escrow.status = EscrowStatus::Released;
            }
        }
        DisputeDecision::RefundToSender => {
            escrow.status = EscrowStatus::Refunded;
        }
        DisputeDecision::Split(_, _) => {
            escrow.status = EscrowStatus::Released;
        }
    }
    
    escrow.status = EscrowStatus::Released;
    storage::save_escrow(env, escrow_id, escrow);
    
    env.events().publish(
        (symbol_short!("disp_exe"), dispute_id),
        executor
    );
    
    Ok(())
}

pub fn conditional_release(
    env: &Env,
    escrow_id: String,
    condition: ReleaseCondition,
    requester: Address,
) -> Result<(), Error> {
    requester.require_auth();
    
    let escrow = storage::get_escrow(env, escrow_id.clone())
        .ok_or(Error::EscrowNotFound)?;
    
    if escrow.status != EscrowStatus::Funded {
        return Err(Error::InvalidStatus);
    }
    
    // Check if requester is a party in the escrow
    let mut is_party = false;
    let mut i = 0;
    while i < escrow.parties.len() {
        let party = escrow.parties.get(i).unwrap();
        if party.eq(&requester) {
            is_party = true;
            break;
        }
        i += 1;
    }
    if !is_party {
        return Err(Error::NotAuthorized);
    }
    
    let condition_met = match condition {
        ReleaseCondition::AllApprove(approvers) => {
            let mut all_approved = true;
            let mut i = 0;
            while i < approvers.len() {
                let approver = approvers.get(i).unwrap();
                let mut found = false;
                let mut j = 0;
                while j < escrow.parties.len() {
                    let party = escrow.parties.get(j).unwrap();
                    if party.eq(&approver) {
                        found = true;
                        break;
                    }
                    j += 1;
                }
                if !found {
                    all_approved = false;
                    break;
                }
                i += 1;
            }
            all_approved
        }
        ReleaseCondition::AnyApprove(approvers) => {
            let mut any_approved = false;
            let mut i = 0;
            while i < approvers.len() {
                let approver = approvers.get(i).unwrap();
                let mut j = 0;
                while j < escrow.parties.len() {
                    let party = escrow.parties.get(j).unwrap();
                    if party.eq(&approver) {
                        any_approved = true;
                        break;
                    }
                    j += 1;
                }
                if any_approved {
                    break;
                }
                i += 1;
            }
            any_approved
        }
        ReleaseCondition::ThresholdApprove(approvers, threshold) => {
            let mut approved_count = 0u32;
            let mut i = 0;
            while i < approvers.len() {
                let approver = approvers.get(i).unwrap();
                let mut j = 0;
                while j < escrow.parties.len() {
                    let party = escrow.parties.get(j).unwrap();
                    if party.eq(&approver) {
                        approved_count += 1;
                        break;
                    }
                    j += 1;
                }
                i += 1;
            }
            approved_count >= threshold
        }
        ReleaseCondition::TimeLock(timestamp) => {
            env.ledger().timestamp() >= timestamp
        }
    };
    
    if condition_met {
        let mut escrow = storage::get_escrow(env, escrow_id.clone())
            .ok_or(Error::EscrowNotFound)?;
        escrow.status = EscrowStatus::Released;
        storage::save_escrow(env, escrow_id, escrow);
        
        env.events().publish(
            (symbol_short!("cond_rel"), escrow_id.clone()),
            requester
        );
    }
    
    Ok(())
}

pub fn claim_timeout_release(
    env: &Env,
    escrow_id: String,
    requester: Address,
) -> Result<(), Error> {
    requester.require_auth();
    
    let mut escrow = storage::get_escrow(env, escrow_id.clone())
        .ok_or(Error::EscrowNotFound)?;
    
    if escrow.status != EscrowStatus::Funded {
        return Err(Error::InvalidStatus);
    }
    
    if env.ledger().timestamp() < escrow.timeout {
        return Err(Error::TimeoutNotReached);
    }
    
    // Check if requester is a party in the escrow
    let mut is_party = false;
    let mut i = 0;
    while i < escrow.parties.len() {
        let party = escrow.parties.get(i).unwrap();
        if party.eq(&requester) {
            is_party = true;
            break;
        }
        i += 1;
    }
    if !is_party {
        return Err(Error::NotAuthorized);
    }
    
    escrow.status = EscrowStatus::Refunded;
    storage::save_escrow(env, escrow_id, escrow);
    
    env.events().publish(
        (symbol_short!("timeout"), escrow_id.clone()),
        requester
    );
    
    Ok(())
}
