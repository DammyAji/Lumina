import { Injectable, Logger } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { sha256 } from '@noble/hashes/sha256';

const SECRET_BYTES = 32;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

export interface SwapSecret {
  /** The 32-byte preimage, hex encoded without `0x`. */
  secret: string;
  /** sha256(secret), hex encoded without `0x`. This is the on-chain hashlock. */
  secretHash: string;
  /** `secret` sealed with AES-256-GCM, safe to persist. */
  encryptedSecret: string;
}

/**
 * Generates, seals, and verifies the preimages behind every swap's hashlock.
 *
 * The secret is the only thing standing between a counterparty and the funds on
 * both legs of a swap, so it is never persisted or logged in the clear: rows
 * hold an AES-256-GCM ciphertext, and the plaintext exists only in memory while
 * a claim is being built. It stops being a secret at all the moment the first
 * claim lands on-chain, which is exactly what settles the other leg.
 */
@Injectable()
export class SecretManagerService {
  private readonly logger = new Logger(SecretManagerService.name);
  private readonly encryptionKey: Buffer;

  constructor() {
    this.encryptionKey = this.loadEncryptionKey();
  }

  /** Creates a fresh secret and the hashlock both HTLCs will be locked under. */
  generateSecret(): SwapSecret {
    const secret = randomBytes(SECRET_BYTES);

    return {
      secret: secret.toString('hex'),
      secretHash: this.hash(secret.toString('hex')),
      encryptedSecret: this.encrypt(secret.toString('hex')),
    };
  }

  /** sha256 of a hex-encoded preimage, hex encoded without `0x`. */
  hash(secretHex: string): string {
    return Buffer.from(sha256(Buffer.from(this.strip(secretHex), 'hex'))).toString('hex');
  }

  /**
   * Constant-time check that `secretHex` is the preimage of `secretHashHex`.
   *
   * Comparison is timing-safe so a caller probing the endpoint with guessed
   * secrets learns nothing from how long the rejection takes.
   */
  verify(secretHex: string, secretHashHex: string): boolean {
    let candidate: Buffer;
    let expected: Buffer;

    try {
      candidate = Buffer.from(this.hash(secretHex), 'hex');
      expected = Buffer.from(this.strip(secretHashHex), 'hex');
    } catch {
      return false;
    }

    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  }

  encrypt(secretHex: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from(this.strip(secretHex), 'hex')),
      cipher.final(),
    ]);

    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
  }

  decrypt(sealed: string): string {
    const raw = Buffer.from(sealed, 'base64');

    if (raw.length <= IV_BYTES + AUTH_TAG_BYTES) {
      throw new Error('Sealed swap secret is malformed');
    }

    const iv = raw.subarray(0, IV_BYTES);
    const authTag = raw.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES);
    const ciphertext = raw.subarray(IV_BYTES + AUTH_TAG_BYTES);

    const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, iv);
    decipher.setAuthTag(authTag);

    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('hex');
  }

  private strip(hex: string): string {
    return hex.startsWith('0x') ? hex.slice(2) : hex;
  }

  private loadEncryptionKey(): Buffer {
    const configured = process.env.SWAP_SECRET_ENCRYPTION_KEY;

    if (configured) {
      const key = Buffer.from(this.strip(configured), 'hex');

      if (key.length !== KEY_BYTES) {
        throw new Error(
          `SWAP_SECRET_ENCRYPTION_KEY must be ${KEY_BYTES} bytes of hex, got ${key.length}`,
        );
      }

      return key;
    }

    // An ephemeral key means every sealed secret becomes unreadable on restart,
    // which would strand in-flight swaps until their timelocks refund them.
    this.logger.warn(
      'SWAP_SECRET_ENCRYPTION_KEY is not set; using an ephemeral key. In-flight swap ' +
        'secrets will not survive a restart. Set it before running cross-chain swaps.',
    );

    return randomBytes(KEY_BYTES);
  }
}
