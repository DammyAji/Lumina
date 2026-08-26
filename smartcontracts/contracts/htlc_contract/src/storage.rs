use soroban_sdk::{BytesN, Env};

use crate::types::{DataKey, Swap};

pub fn save_swap(env: &Env, swap: &Swap) {
    env.storage()
        .persistent()
        .set::<DataKey, Swap>(&DataKey::Swap(swap.swap_id.clone()), swap);
}

pub fn get_swap(env: &Env, swap_id: &BytesN<32>) -> Option<Swap> {
    env.storage()
        .persistent()
        .get::<DataKey, Swap>(&DataKey::Swap(swap_id.clone()))
}

pub fn swap_exists(env: &Env, swap_id: &BytesN<32>) -> bool {
    env.storage()
        .persistent()
        .has(&DataKey::Swap(swap_id.clone()))
}

pub fn save_preimage(env: &Env, swap_id: &BytesN<32>, preimage: &BytesN<32>) {
    env.storage()
        .persistent()
        .set::<DataKey, BytesN<32>>(&DataKey::Preimage(swap_id.clone()), preimage);
}

pub fn get_preimage(env: &Env, swap_id: &BytesN<32>) -> Option<BytesN<32>> {
    env.storage()
        .persistent()
        .get::<DataKey, BytesN<32>>(&DataKey::Preimage(swap_id.clone()))
}
