#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token, Address, Bytes, Env,
};

const START_LEDGER: u32 = 100;
const TIMEOUT_LEDGER: u32 = 200;
const AMOUNT: i128 = 1_000;

struct Fixture {
    env: Env,
    client: HtlcContractClient<'static>,
    token: Address,
    token_client: token::Client<'static>,
    sender: Address,
    recipient: Address,
    preimage: BytesN<32>,
    secret_hash: BytesN<32>,
}

fn setup() -> Fixture {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|li| li.sequence_number = START_LEDGER);

    let contract_id = env.register_contract(None, HtlcContract);
    let client = HtlcContractClient::new(&env, &contract_id);

    let token_admin = Address::generate(&env);
    let token = env.register_stellar_asset_contract(token_admin.clone());
    let token_client = token::Client::new(&env, &token);

    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);

    token::StellarAssetClient::new(&env, &token).mint(&sender, &AMOUNT);

    let preimage = BytesN::from_array(&env, &[7u8; 32]);
    let secret_hash: BytesN<32> = env
        .crypto()
        .sha256(&Bytes::from_array(&env, &[7u8; 32]))
        .into();

    Fixture {
        env,
        client,
        token,
        token_client,
        sender,
        recipient,
        preimage,
        secret_hash,
    }
}

impl Fixture {
    fn swap_id(&self) -> BytesN<32> {
        BytesN::from_array(&self.env, &[1u8; 32])
    }

    fn lock(&self) {
        self.client.lock(
            &self.swap_id(),
            &self.sender,
            &self.recipient,
            &self.token,
            &AMOUNT,
            &self.secret_hash,
            &TIMEOUT_LEDGER,
        );
    }

    fn advance_to(&self, ledger: u32) {
        self.env.ledger().with_mut(|li| li.sequence_number = ledger);
    }
}

#[test]
fn lock_escrows_the_funds_in_the_contract() {
    let f = setup();
    f.lock();

    let swap = f.client.get_swap(&f.swap_id()).unwrap();
    assert_eq!(swap.sender, f.sender);
    assert_eq!(swap.recipient, f.recipient);
    assert_eq!(swap.amount, AMOUNT);
    assert_eq!(swap.secret_hash, f.secret_hash);
    assert_eq!(swap.timeout_ledger, TIMEOUT_LEDGER);
    assert_eq!(swap.status, SwapStatus::Locked);

    assert_eq!(f.token_client.balance(&f.sender), 0);
    assert_eq!(f.token_client.balance(&f.client.address), AMOUNT);
}

#[test]
fn lock_rejects_a_duplicate_swap_id() {
    let f = setup();
    f.lock();

    let err = f
        .client
        .try_lock(
            &f.swap_id(),
            &f.sender,
            &f.recipient,
            &f.token,
            &AMOUNT,
            &f.secret_hash,
            &TIMEOUT_LEDGER,
        )
        .unwrap_err()
        .unwrap();

    assert_eq!(err, Error::SwapAlreadyExists);
}

#[test]
fn lock_rejects_a_non_positive_amount() {
    let f = setup();

    let err = f
        .client
        .try_lock(
            &f.swap_id(),
            &f.sender,
            &f.recipient,
            &f.token,
            &0i128,
            &f.secret_hash,
            &TIMEOUT_LEDGER,
        )
        .unwrap_err()
        .unwrap();

    assert_eq!(err, Error::InvalidAmount);
}

#[test]
fn lock_rejects_a_timeout_that_is_not_in_the_future() {
    let f = setup();

    let err = f
        .client
        .try_lock(
            &f.swap_id(),
            &f.sender,
            &f.recipient,
            &f.token,
            &AMOUNT,
            &f.secret_hash,
            &START_LEDGER,
        )
        .unwrap_err()
        .unwrap();

    assert_eq!(err, Error::InvalidTimeout);
}

#[test]
fn lock_rejects_a_swap_to_the_sender() {
    let f = setup();

    let err = f
        .client
        .try_lock(
            &f.swap_id(),
            &f.sender,
            &f.sender,
            &f.token,
            &AMOUNT,
            &f.secret_hash,
            &TIMEOUT_LEDGER,
        )
        .unwrap_err()
        .unwrap();

    assert_eq!(err, Error::SameSenderAndRecipient);
}

#[test]
fn claim_pays_the_recipient_and_reveals_the_preimage() {
    let f = setup();
    f.lock();

    f.client.claim(&f.swap_id(), &f.preimage);

    let swap = f.client.get_swap(&f.swap_id()).unwrap();
    assert_eq!(swap.status, SwapStatus::Claimed);
    assert_eq!(f.token_client.balance(&f.recipient), AMOUNT);
    assert_eq!(f.token_client.balance(&f.client.address), 0);

    // The revealed preimage is what settles the counterparty chain's leg.
    assert_eq!(f.client.get_preimage(&f.swap_id()), Some(f.preimage.clone()));
}

#[test]
fn claim_rejects_a_wrong_preimage() {
    let f = setup();
    f.lock();

    let wrong = BytesN::from_array(&f.env, &[8u8; 32]);
    let err = f.client.try_claim(&f.swap_id(), &wrong).unwrap_err().unwrap();

    assert_eq!(err, Error::InvalidPreimage);
    assert_eq!(f.token_client.balance(&f.recipient), 0);
}

#[test]
fn claim_rejects_an_unknown_swap() {
    let f = setup();

    let unknown = BytesN::from_array(&f.env, &[9u8; 32]);
    let err = f.client.try_claim(&unknown, &f.preimage).unwrap_err().unwrap();

    assert_eq!(err, Error::SwapNotFound);
}

#[test]
fn claim_rejects_a_swap_that_is_already_claimed() {
    let f = setup();
    f.lock();
    f.client.claim(&f.swap_id(), &f.preimage);

    let err = f
        .client
        .try_claim(&f.swap_id(), &f.preimage)
        .unwrap_err()
        .unwrap();

    assert_eq!(err, Error::SwapNotLocked);
}

#[test]
fn claim_rejects_a_swap_whose_timelock_expired() {
    let f = setup();
    f.lock();
    f.advance_to(TIMEOUT_LEDGER);

    let err = f
        .client
        .try_claim(&f.swap_id(), &f.preimage)
        .unwrap_err()
        .unwrap();

    assert_eq!(err, Error::TimelockExpired);
}

#[test]
fn refund_returns_the_funds_after_the_timelock() {
    let f = setup();
    f.lock();
    f.advance_to(TIMEOUT_LEDGER);

    f.client.refund(&f.swap_id());

    let swap = f.client.get_swap(&f.swap_id()).unwrap();
    assert_eq!(swap.status, SwapStatus::Refunded);
    assert_eq!(f.token_client.balance(&f.sender), AMOUNT);
    assert_eq!(f.token_client.balance(&f.client.address), 0);
}

#[test]
fn refund_rejects_a_swap_whose_timelock_has_not_expired() {
    let f = setup();
    f.lock();

    let err = f.client.try_refund(&f.swap_id()).unwrap_err().unwrap();

    assert_eq!(err, Error::TimelockNotExpired);
    assert_eq!(f.token_client.balance(&f.sender), 0);
}

#[test]
fn refund_rejects_a_swap_that_was_already_claimed() {
    let f = setup();
    f.lock();
    f.client.claim(&f.swap_id(), &f.preimage);
    f.advance_to(TIMEOUT_LEDGER);

    let err = f.client.try_refund(&f.swap_id()).unwrap_err().unwrap();

    assert_eq!(err, Error::SwapNotLocked);
}

#[test]
fn get_swap_returns_none_for_an_unknown_swap() {
    let f = setup();

    let unknown = BytesN::from_array(&f.env, &[9u8; 32]);
    assert_eq!(f.client.get_swap(&unknown), None);
}

#[test]
fn get_preimage_returns_none_while_the_swap_is_locked() {
    let f = setup();
    f.lock();

    assert_eq!(f.client.get_preimage(&f.swap_id()), None);
}
