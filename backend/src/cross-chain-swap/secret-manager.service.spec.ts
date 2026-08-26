import { createHash } from 'node:crypto';
import { SecretManagerService } from './secret-manager.service';

const TEST_KEY = 'a'.repeat(64);

describe('SecretManagerService', () => {
  let service: SecretManagerService;

  beforeEach(() => {
    process.env.SWAP_SECRET_ENCRYPTION_KEY = TEST_KEY;
    service = new SecretManagerService();
  });

  afterEach(() => {
    delete process.env.SWAP_SECRET_ENCRYPTION_KEY;
  });

  describe('generateSecret', () => {
    it('returns a 32-byte secret with a matching sha256 hashlock', () => {
      const { secret, secretHash } = service.generateSecret();

      expect(secret).toMatch(/^[0-9a-f]{64}$/);
      expect(secretHash).toEqual(createHash('sha256').update(Buffer.from(secret, 'hex')).digest('hex'));
    });

    it('never returns the same secret twice', () => {
      const secrets = new Set(Array.from({ length: 50 }, () => service.generateSecret().secret));

      expect(secrets.size).toBe(50);
    });

    it('seals the secret so the plaintext is not in the persisted value', () => {
      const { secret, encryptedSecret } = service.generateSecret();

      expect(encryptedSecret).not.toContain(secret);
      expect(service.decrypt(encryptedSecret)).toEqual(secret);
    });
  });

  describe('hash', () => {
    it('matches sha256 of the raw preimage bytes, not of its hex text', () => {
      const secret = '00'.repeat(32);

      expect(service.hash(secret)).toEqual(
        createHash('sha256').update(Buffer.alloc(32)).digest('hex'),
      );
    });

    it('ignores a 0x prefix', () => {
      const secret = 'ab'.repeat(32);

      expect(service.hash(`0x${secret}`)).toEqual(service.hash(secret));
    });
  });

  describe('verify', () => {
    it('accepts the matching preimage', () => {
      const { secret, secretHash } = service.generateSecret();

      expect(service.verify(secret, secretHash)).toBe(true);
    });

    it('rejects a different preimage', () => {
      const { secretHash } = service.generateSecret();

      expect(service.verify('11'.repeat(32), secretHash)).toBe(false);
    });

    it('rejects a hash of the wrong length instead of throwing', () => {
      const { secret } = service.generateSecret();

      expect(service.verify(secret, 'abcd')).toBe(false);
    });

    it('rejects non-hex input instead of throwing', () => {
      expect(service.verify('nothex', 'a'.repeat(64))).toBe(false);
    });
  });

  describe('encrypt / decrypt', () => {
    it('round-trips a secret', () => {
      const secret = 'cd'.repeat(32);

      expect(service.decrypt(service.encrypt(secret))).toEqual(secret);
    });

    it('uses a fresh nonce for every seal', () => {
      const secret = 'cd'.repeat(32);

      expect(service.encrypt(secret)).not.toEqual(service.encrypt(secret));
    });

    it('rejects a ciphertext that has been tampered with', () => {
      const sealed = Buffer.from(service.encrypt('cd'.repeat(32)), 'base64');
      sealed[sealed.length - 1] ^= 0xff;

      expect(() => service.decrypt(sealed.toString('base64'))).toThrow();
    });

    it('rejects a truncated ciphertext', () => {
      expect(() => service.decrypt(Buffer.alloc(8).toString('base64'))).toThrow(/malformed/);
    });

    it('cannot read a secret sealed under a different key', () => {
      const sealed = service.encrypt('cd'.repeat(32));

      process.env.SWAP_SECRET_ENCRYPTION_KEY = 'b'.repeat(64);
      const other = new SecretManagerService();

      expect(() => other.decrypt(sealed)).toThrow();
    });
  });

  describe('configuration', () => {
    it('rejects a key that is not 32 bytes', () => {
      process.env.SWAP_SECRET_ENCRYPTION_KEY = 'ab';

      expect(() => new SecretManagerService()).toThrow(/must be 32 bytes/);
    });

    it('falls back to an ephemeral key when none is configured', () => {
      delete process.env.SWAP_SECRET_ENCRYPTION_KEY;

      const ephemeral = new SecretManagerService();
      const { secret, encryptedSecret } = ephemeral.generateSecret();

      expect(ephemeral.decrypt(encryptedSecret)).toEqual(secret);
    });
  });
});
