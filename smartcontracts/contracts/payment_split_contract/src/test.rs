#![cfg(test)]

use super::*;
use soroban_sdk::{Address, String, Vec};
use soroban_sdk::testutils::Address as _;

#[test]
fn test_initialize() {
    let env = soroban_sdk::Env::default();
    let contract_id = env.register_contract(None, PaymentSplitContract);
    let client = PaymentSplitContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    
    client.initialize(&admin);
    
    assert_eq!(client.version(), 1);
}

#[test]
#[should_panic(expected = "Already initialized")]
fn test_initialize_twice() {
    let env = soroban_sdk::Env::default();
    let contract_id = env.register_contract(None, PaymentSplitContract);
    let client = PaymentSplitContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    
    client.initialize(&admin);
    client.initialize(&admin);
}

#[test]
fn test_create_split() {
    let env = soroban_sdk::Env::default();
    let contract_id = env.register_contract(None, PaymentSplitContract);
    let client = PaymentSplitContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    client.initialize(&admin);

    let from = Address::generate(&env);
    let split_id = String::from_str(&env, "split_1");
    
    let recipient1 = Address::generate(&env);
    let recipient2 = Address::generate(&env);
    
    let mut recipients = Vec::new(&env);
    recipients.push_back(types::Recipient {
        address: recipient1.clone(),
        percentage: 60,
    });
    recipients.push_back(types::Recipient {
        address: recipient2.clone(),
        percentage: 40,
    });

    client.create_split(&from, &split_id, &recipients);
}

#[test]
fn test_execute_split() {
    let env = soroban_sdk::Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, PaymentSplitContract);
    let client = PaymentSplitContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    client.initialize(&admin);

    let from = Address::generate(&env);
    let split_id = String::from_str(&env, "split_1");
    
    let recipient1 = Address::generate(&env);
    let recipient2 = Address::generate(&env);
    
    let mut recipients = Vec::new(&env);
    recipients.push_back(types::Recipient {
        address: recipient1.clone(),
        percentage: 60,
    });
    recipients.push_back(types::Recipient {
        address: recipient2.clone(),
        percentage: 40,
    });

    client.create_split(&from, &split_id, &recipients);

    let amount: i128 = 1000;
    let distributions = client.execute_split(&split_id, &amount);
    assert_eq!(distributions.len(), 2);
    assert_eq!(distributions.get(0).unwrap().1, 600);
    assert_eq!(distributions.get(1).unwrap().1, 400);
}

#[test]
fn test_update_split() {
    let env = soroban_sdk::Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, PaymentSplitContract);
    let client = PaymentSplitContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    client.initialize(&admin);

    let from = Address::generate(&env);
    let split_id = String::from_str(&env, "split_1");
    
    let recipient1 = Address::generate(&env);
    let recipient2 = Address::generate(&env);
    
    let mut recipients = Vec::new(&env);
    recipients.push_back(types::Recipient {
        address: recipient1.clone(),
        percentage: 60,
    });
    recipients.push_back(types::Recipient {
        address: recipient2.clone(),
        percentage: 40,
    });

    client.create_split(&from, &split_id, &recipients);

    let recipient3 = Address::generate(&env);
    let mut new_recipients = Vec::new(&env);
    new_recipients.push_back(types::Recipient {
        address: recipient1.clone(),
        percentage: 50,
    });
    new_recipients.push_back(types::Recipient {
        address: recipient3.clone(),
        percentage: 50,
    });

    client.update_split(&split_id, &new_recipients);

    let split = client.get_split(&split_id);
    assert_eq!(split.recipients.len(), 2);
    assert_eq!(split.total_percentage, 100);
}

#[test]
fn test_get_split() {
    let env = soroban_sdk::Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, PaymentSplitContract);
    let client = PaymentSplitContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    client.initialize(&admin);

    let from = Address::generate(&env);
    let split_id = String::from_str(&env, "split_1");
    
    let recipient1 = Address::generate(&env);
    let recipient2 = Address::generate(&env);
    
    let mut recipients = Vec::new(&env);
    recipients.push_back(types::Recipient {
        address: recipient1.clone(),
        percentage: 60,
    });
    recipients.push_back(types::Recipient {
        address: recipient2.clone(),
        percentage: 40,
    });

    client.create_split(&from, &split_id, &recipients);

    let split_rule = client.get_split(&split_id);
    assert_eq!(split_rule.split_id, split_id);
    assert_eq!(split_rule.from_address, from);
    assert_eq!(split_rule.recipients.len(), 2);
    assert_eq!(split_rule.total_percentage, 100);
}

#[test]
fn test_many_recipients() {
    let env = soroban_sdk::Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, PaymentSplitContract);
    let client = PaymentSplitContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    client.initialize(&admin);

    let from = Address::generate(&env);
    let split_id = String::from_str(&env, "split_many");
    
    let mut recipients = Vec::new(&env);
    let mut percentage_sum = 0;
    
    for i in 0..10 {
        let recipient = Address::generate(&env);
        let percentage = if i == 9 { 100 - percentage_sum } else { 10 };
        percentage_sum += percentage;
        recipients.push_back(types::Recipient {
            address: recipient,
            percentage,
        });
    }

    client.create_split(&from, &split_id, &recipients);

    let split = client.get_split(&split_id);
    assert_eq!(split.recipients.len(), 10);
    assert_eq!(split.total_percentage, 100);
}
