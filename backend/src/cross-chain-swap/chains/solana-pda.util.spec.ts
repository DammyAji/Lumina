import { base58Decode, base58Encode, findProgramAddress, isOnCurve } from './solana-pda.util';

// The SPL Token program, a well-known base58 address.
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

describe('base58', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = Uint8Array.from(Array.from({ length: 32 }, (_, i) => (i * 7) % 256));

    expect(base58Decode(base58Encode(bytes))).toEqual(bytes);
  });

  it('round-trips a known Solana address', () => {
    expect(base58Encode(base58Decode(TOKEN_PROGRAM))).toEqual(TOKEN_PROGRAM);
  });

  it('decodes a 32-byte address to 32 bytes', () => {
    expect(base58Decode(TOKEN_PROGRAM).length).toEqual(32);
  });

  it('preserves leading zero bytes as leading ones', () => {
    const bytes = Uint8Array.from([0, 0, 1]);

    expect(base58Encode(bytes).startsWith('11')).toBe(true);
    expect(base58Decode(base58Encode(bytes))).toEqual(bytes);
  });

  it('rejects characters outside the alphabet', () => {
    expect(() => base58Decode('0OIl')).toThrow(/not valid base58/);
  });
});

describe('isOnCurve', () => {
  it('rejects bytes that are not a valid ed25519 point', () => {
    expect(isOnCurve(Uint8Array.from(Array(32).fill(0xff)))).toBe(false);
  });
});

describe('findProgramAddress', () => {
  const seeds = [Buffer.from('swap', 'utf8'), Buffer.from('11'.repeat(32), 'hex')];

  it('derives a 32-byte address that is off the ed25519 curve', () => {
    const { address, bump } = findProgramAddress(seeds, TOKEN_PROGRAM);

    expect(base58Decode(address).length).toEqual(32);
    expect(isOnCurve(base58Decode(address))).toBe(false);
    expect(bump).toBeGreaterThanOrEqual(0);
    expect(bump).toBeLessThanOrEqual(255);
  });

  it('is deterministic for the same seeds and program', () => {
    expect(findProgramAddress(seeds, TOKEN_PROGRAM)).toEqual(
      findProgramAddress(seeds, TOKEN_PROGRAM),
    );
  });

  it('derives a different address for different seeds', () => {
    const other = [Buffer.from('swap', 'utf8'), Buffer.from('22'.repeat(32), 'hex')];

    expect(findProgramAddress(other, TOKEN_PROGRAM).address).not.toEqual(
      findProgramAddress(seeds, TOKEN_PROGRAM).address,
    );
  });

  it('derives a different address under a different program', () => {
    const otherProgram = '11111111111111111111111111111111';

    expect(findProgramAddress(seeds, otherProgram).address).not.toEqual(
      findProgramAddress(seeds, TOKEN_PROGRAM).address,
    );
  });

  it('rejects a seed longer than 32 bytes', () => {
    expect(() => findProgramAddress([Buffer.alloc(33)], TOKEN_PROGRAM)).toThrow(/at most 32 bytes/);
  });
});
