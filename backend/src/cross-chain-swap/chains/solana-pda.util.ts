import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';

const PDA_MARKER = Buffer.from('ProgramDerivedAddress', 'utf8');
const MAX_SEED_LENGTH = 32;
const MAX_BUMP = 255;

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export interface ProgramAddress {
  /** Base58-encoded address. */
  address: string;
  bump: number;
}

/**
 * Solana's `find_program_address`, reimplemented so the backend can derive a
 * swap's PDA without pulling in @solana/web3.js.
 *
 * The derivation walks bumps down from 255 and takes the first candidate that
 * is *off* the ed25519 curve — an on-curve point would be a real keypair
 * someone could hold the private key for.
 */
export function findProgramAddress(seeds: Uint8Array[], programId: string): ProgramAddress {
  for (const seed of seeds) {
    if (seed.length > MAX_SEED_LENGTH) {
      throw new Error(`PDA seeds are at most ${MAX_SEED_LENGTH} bytes, got ${seed.length}`);
    }
  }

  const programIdBytes = base58Decode(programId);

  for (let bump = MAX_BUMP; bump >= 0; bump--) {
    const candidate = sha256(
      Buffer.concat([
        ...seeds.map((seed) => Buffer.from(seed)),
        Buffer.from([bump]),
        Buffer.from(programIdBytes),
        PDA_MARKER,
      ]),
    );

    if (!isOnCurve(candidate)) {
      return { address: base58Encode(candidate), bump };
    }
  }

  throw new Error('Unable to find a program address off the ed25519 curve');
}

/** True when `bytes` decodes as a valid ed25519 point. */
export function isOnCurve(bytes: Uint8Array): boolean {
  try {
    ed25519.ExtendedPoint.fromHex(Buffer.from(bytes).toString('hex'));
    return true;
  } catch {
    return false;
  }
}

export function base58Encode(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) {
    value = value * 256n + BigInt(byte);
  }

  let encoded = '';
  while (value > 0n) {
    encoded = BASE58_ALPHABET[Number(value % 58n)] + encoded;
    value /= 58n;
  }

  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded = `1${encoded}`;
  }

  return encoded || '1';
}

export function base58Decode(value: string): Uint8Array {
  let decoded = 0n;

  for (const char of value) {
    const index = BASE58_ALPHABET.indexOf(char);

    if (index < 0) {
      throw new Error(`"${value}" is not valid base58`);
    }

    decoded = decoded * 58n + BigInt(index);
  }

  const bytes: number[] = [];
  while (decoded > 0n) {
    bytes.unshift(Number(decoded % 256n));
    decoded /= 256n;
  }

  for (const char of value) {
    if (char !== '1') break;
    bytes.unshift(0);
  }

  return Uint8Array.from(bytes);
}
