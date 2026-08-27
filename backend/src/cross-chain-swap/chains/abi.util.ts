/**
 * Minimal ABI encoding/decoding for the handful of `LuminaHTLC` calls this
 * module makes.
 *
 * Selectors are hard-coded rather than derived, because computing them needs
 * keccak256 and the backend has no EVM library — the same approach the
 * Chainlink price provider already takes for its feed calls.
 */

export const WORD_HEX = 64;

export function stripHexPrefix(value: string): string {
  return value.startsWith('0x') || value.startsWith('0X') ? value.slice(2) : value;
}

/** Left-pads a hex value to a full 32-byte ABI word. */
export function encodeWord(value: string | bigint | number): string {
  if (typeof value === 'string') {
    return stripHexPrefix(value).toLowerCase().padStart(WORD_HEX, '0');
  }

  return BigInt(value).toString(16).padStart(WORD_HEX, '0');
}

/** Encodes a 20-byte address as a left-padded ABI word. */
export function encodeAddress(address: string): string {
  return encodeWord(stripHexPrefix(address));
}

export function encodeCall(selector: string, args: Array<string | bigint | number>): string {
  return `0x${stripHexPrefix(selector)}${args.map(encodeWord).join('')}`;
}

/** Returns the `index`-th 32-byte word of an ABI-encoded return value. */
export function readWord(data: string, index: number): string {
  const body = stripHexPrefix(data);
  const start = index * WORD_HEX;

  if (body.length < start + WORD_HEX) {
    throw new Error(`ABI response is too short to hold word ${index}`);
  }

  return body.slice(start, start + WORD_HEX);
}

export function readUint(data: string, index: number): bigint {
  return BigInt(`0x${readWord(data, index)}`);
}

/** Reads a word as a 20-byte address, dropping the 12 bytes of left padding. */
export function readAddress(data: string, index: number): string {
  return `0x${readWord(data, index).slice(24)}`;
}

export function readBytes32(data: string, index: number): string {
  return readWord(data, index);
}
