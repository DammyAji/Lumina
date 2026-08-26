import { ripemd160 } from '@noble/hashes/ripemd160';
import { sha256 } from '@noble/hashes/sha256';

/**
 * Bitcoin's HTLC is a redeem script rather than a deployed contract, so this
 * module builds the script and both address forms it can be paid to.
 *
 * The script has the same two branches as every other chain's HTLC:
 *
 * ```
 * OP_IF
 *     OP_SHA256 <secretHash> OP_EQUALVERIFY <recipientPubKey> OP_CHECKSIG
 * OP_ELSE
 *     <locktime> OP_CHECKLOCKTIMEVERIFY OP_DROP <senderPubKey> OP_CHECKSIG
 * OP_ENDIF
 * ```
 *
 * The `OP_IF` branch is the claim: the recipient spends by revealing the
 * preimage. The `OP_ELSE` branch is the refund: `OP_CHECKLOCKTIMEVERIFY` makes
 * the script unspendable by the sender until `locktime`, so the two branches
 * can never both be live at the same height.
 */

const OP_IF = 0x63;
const OP_ELSE = 0x67;
const OP_ENDIF = 0x68;
const OP_DROP = 0x75;
const OP_EQUALVERIFY = 0x88;
const OP_SHA256 = 0xa8;
const OP_CHECKSIG = 0xac;
const OP_CHECKLOCKTIMEVERIFY = 0xb1;

export enum BitcoinNetwork {
  MAINNET = 'mainnet',
  TESTNET = 'testnet',
}

interface NetworkParams {
  p2shVersion: number;
  bech32Hrp: string;
}

const NETWORKS: Record<BitcoinNetwork, NetworkParams> = {
  [BitcoinNetwork.MAINNET]: { p2shVersion: 0x05, bech32Hrp: 'bc' },
  [BitcoinNetwork.TESTNET]: { p2shVersion: 0xc4, bech32Hrp: 'tb' },
};

export interface HtlcScriptParams {
  /** sha256 hashlock, hex without `0x`. */
  secretHash: string;
  /** Compressed (33-byte) or uncompressed (65-byte) pubkey, hex. */
  recipientPubKey: string;
  senderPubKey: string;
  /** Block height the refund branch unlocks at. */
  locktime: number;
  network: BitcoinNetwork;
}

export interface HtlcScript {
  /** Redeem/witness script, hex. */
  script: string;
  /** Legacy P2SH address — `3…` on mainnet, `2…` on testnet. */
  p2shAddress: string;
  /** SegWit v0 P2WSH address — `bc1…` / `tb1…`. */
  p2wshAddress: string;
  /** `scriptPubKey` a P2SH output pays to. */
  p2shScriptPubKey: string;
  p2wshScriptPubKey: string;
}

/**
 * Locktimes below this are interpreted as block heights and at or above it as
 * unix timestamps (BIP-65). Lumina always uses heights, so a value in the
 * timestamp range means the caller mixed up the units.
 */
export const LOCKTIME_THRESHOLD = 500_000_000;

export function buildHtlcScript(params: HtlcScriptParams): HtlcScript {
  const secretHash = assertHex(params.secretHash, 32, 'secretHash');
  const recipientPubKey = assertPubKey(params.recipientPubKey, 'recipientPubKey');
  const senderPubKey = assertPubKey(params.senderPubKey, 'senderPubKey');

  if (!Number.isInteger(params.locktime) || params.locktime <= 0) {
    throw new Error('locktime must be a positive block height');
  }

  if (params.locktime >= LOCKTIME_THRESHOLD) {
    throw new Error(
      `locktime ${params.locktime} is in the unix-timestamp range; HTLC locktimes are block heights`,
    );
  }

  const script = Uint8Array.from([
    OP_IF,
    OP_SHA256,
    ...pushData(secretHash),
    OP_EQUALVERIFY,
    ...pushData(recipientPubKey),
    OP_CHECKSIG,
    OP_ELSE,
    ...pushData(encodeScriptNumber(params.locktime)),
    OP_CHECKLOCKTIMEVERIFY,
    OP_DROP,
    ...pushData(senderPubKey),
    OP_CHECKSIG,
    OP_ENDIF,
  ]);

  const { p2shVersion, bech32Hrp } = NETWORKS[params.network];
  const scriptHash160 = ripemd160(sha256(script));
  const scriptSha256 = sha256(script);

  return {
    script: toHex(script),
    p2shAddress: base58Check(p2shVersion, scriptHash160),
    p2wshAddress: encodeBech32(bech32Hrp, 0, scriptSha256),
    // OP_HASH160 <20-byte hash> OP_EQUAL
    p2shScriptPubKey: `a914${toHex(scriptHash160)}87`,
    // OP_0 <32-byte hash>
    p2wshScriptPubKey: `0020${toHex(scriptSha256)}`,
  };
}

/** Minimally-encoded CScriptNum: little-endian, sign bit in the top byte. */
export function encodeScriptNumber(value: number): Uint8Array {
  if (value === 0) {
    return new Uint8Array(0);
  }

  const bytes: number[] = [];
  let remaining = value;

  while (remaining > 0) {
    bytes.push(remaining & 0xff);
    remaining = Math.floor(remaining / 256);
  }

  // A set high bit would read as negative, so pad with a zero byte.
  if (bytes[bytes.length - 1] & 0x80) {
    bytes.push(0x00);
  }

  return Uint8Array.from(bytes);
}

/** Prefixes `data` with its push opcode. Scripts here never exceed 75 bytes. */
function pushData(data: Uint8Array): number[] {
  if (data.length > 75) {
    throw new Error('HTLC script pushes are always direct pushes of at most 75 bytes');
  }

  return [data.length, ...data];
}

function base58Check(version: number, payload: Uint8Array): string {
  const versioned = Uint8Array.from([version, ...payload]);
  const checksum = sha256(sha256(versioned)).slice(0, 4);

  return base58Encode(Uint8Array.from([...versioned, ...checksum]));
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) {
    value = value * 256n + BigInt(byte);
  }

  let encoded = '';
  while (value > 0n) {
    encoded = BASE58_ALPHABET[Number(value % 58n)] + encoded;
    value /= 58n;
  }

  // Each leading zero byte is a literal '1' rather than part of the number.
  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded = `1${encoded}`;
  }

  return encoded;
}

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

/** BIP-173 bech32 encoding of a witness program. */
function encodeBech32(hrp: string, witnessVersion: number, program: Uint8Array): string {
  const data = [witnessVersion, ...convertBits(program, 8, 5, true)];
  const checksum = bech32Checksum(hrp, data);

  return `${hrp}1${[...data, ...checksum].map((value) => BECH32_CHARSET[value]).join('')}`;
}

function convertBits(data: Uint8Array, from: number, to: number, pad: boolean): number[] {
  let accumulator = 0;
  let bits = 0;
  const result: number[] = [];
  const maxValue = (1 << to) - 1;

  for (const value of data) {
    accumulator = (accumulator << from) | value;
    bits += from;

    while (bits >= to) {
      bits -= to;
      result.push((accumulator >> bits) & maxValue);
    }
  }

  if (pad && bits > 0) {
    result.push((accumulator << (to - bits)) & maxValue);
  }

  return result;
}

function bech32Polymod(values: number[]): number {
  const generator = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let checksum = 1;

  for (const value of values) {
    const top = checksum >> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;

    for (let i = 0; i < 5; i++) {
      if ((top >> i) & 1) {
        checksum ^= generator[i];
      }
    }
  }

  return checksum;
}

function bech32Checksum(hrp: string, data: number[]): number[] {
  const expanded = [
    ...[...hrp].map((char) => char.charCodeAt(0) >> 5),
    0,
    ...[...hrp].map((char) => char.charCodeAt(0) & 31),
  ];
  const polymod = bech32Polymod([...expanded, ...data, 0, 0, 0, 0, 0, 0]) ^ 1;

  return [0, 1, 2, 3, 4, 5].map((i) => (polymod >> (5 * (5 - i))) & 31);
}

function assertHex(value: string, expectedBytes: number, field: string): Uint8Array {
  const bytes = fromHex(value, field);

  if (bytes.length !== expectedBytes) {
    throw new Error(`${field} must be ${expectedBytes} bytes, got ${bytes.length}`);
  }

  return bytes;
}

function assertPubKey(value: string, field: string): Uint8Array {
  const bytes = fromHex(value, field);

  if (bytes.length !== 33 && bytes.length !== 65) {
    throw new Error(`${field} must be a 33- or 65-byte public key, got ${bytes.length} bytes`);
  }

  return bytes;
}

function fromHex(value: string, field: string): Uint8Array {
  const normalised = value.startsWith('0x') ? value.slice(2) : value;

  if (!/^[0-9a-fA-F]*$/.test(normalised) || normalised.length % 2 !== 0) {
    throw new Error(`${field} must be an even-length hex string`);
  }

  return Uint8Array.from(
    normalised.match(/.{2}/g)?.map((byte) => parseInt(byte, 16)) ?? [],
  );
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}
