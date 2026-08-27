import { CHAIN_METADATA, SwapChain } from './chain.enum';

/**
 * Converts a decimal amount string into a chain's smallest unit.
 *
 * Done on strings rather than via `Number` so an 18-decimal wei amount survives
 * without losing precision to a float.
 */
export function toSmallestUnit(amount: string, chain: SwapChain): bigint {
  const { decimals } = CHAIN_METADATA[chain];
  const parts = amount.trim().split('.');
  const [whole, fraction = ''] = parts;

  if (parts.length > 2 || !/^\d+$/.test(whole) || !/^\d*$/.test(fraction)) {
    throw new Error(`"${amount}" is not a valid decimal amount`);
  }

  return BigInt(`${whole}${fraction.padEnd(decimals, '0').slice(0, decimals)}`);
}

/** Inverse of `toSmallestUnit`, with trailing zeros trimmed. */
export function fromSmallestUnit(amount: bigint | string, chain: SwapChain): string {
  const { decimals } = CHAIN_METADATA[chain];
  const digits = BigInt(amount).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '');

  return fraction ? `${whole}.${fraction}` : whole;
}
