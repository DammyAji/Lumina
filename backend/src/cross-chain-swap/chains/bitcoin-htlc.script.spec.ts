import {
  BitcoinNetwork,
  buildHtlcScript,
  encodeScriptNumber,
  LOCKTIME_THRESHOLD,
} from './bitcoin-htlc.script';

const SECRET_HASH = 'a'.repeat(64);
const RECIPIENT_PUBKEY = `02${'b'.repeat(64)}`;
const SENDER_PUBKEY = `03${'c'.repeat(64)}`;

function build(overrides: Partial<Parameters<typeof buildHtlcScript>[0]> = {}) {
  return buildHtlcScript({
    secretHash: SECRET_HASH,
    recipientPubKey: RECIPIENT_PUBKEY,
    senderPubKey: SENDER_PUBKEY,
    locktime: 800_000,
    network: BitcoinNetwork.TESTNET,
    ...overrides,
  });
}

describe('buildHtlcScript', () => {
  it('lays out both branches of the HTLC in order', () => {
    const { script } = build();

    // OP_IF OP_SHA256 <push 32> <hash> OP_EQUALVERIFY <push 33> <pubkey> OP_CHECKSIG
    expect(script.startsWith(`63a820${SECRET_HASH}88`)).toBe(true);
    expect(script).toContain(`21${RECIPIENT_PUBKEY}ac67`);
    // <push 3> <locktime LE> OP_CHECKLOCKTIMEVERIFY OP_DROP <push 33> <pubkey> OP_CHECKSIG OP_ENDIF
    expect(script).toContain(`0300350cb175`);
    expect(script.endsWith(`21${SENDER_PUBKEY}ac68`)).toBe(true);
  });

  it('produces a P2SH address and matching scriptPubKey', () => {
    const { p2shAddress, p2shScriptPubKey } = build();

    // Testnet P2SH addresses start with 2.
    expect(p2shAddress.startsWith('2')).toBe(true);
    expect(p2shScriptPubKey).toMatch(/^a914[0-9a-f]{40}87$/);
  });

  it('produces a P2WSH address and matching scriptPubKey', () => {
    const { p2wshAddress, p2wshScriptPubKey } = build();

    expect(p2wshAddress.startsWith('tb1q')).toBe(true);
    expect(p2wshScriptPubKey).toMatch(/^0020[0-9a-f]{64}$/);
  });

  it('uses mainnet prefixes on mainnet', () => {
    const { p2shAddress, p2wshAddress } = build({ network: BitcoinNetwork.MAINNET });

    expect(p2shAddress.startsWith('3')).toBe(true);
    expect(p2wshAddress.startsWith('bc1q')).toBe(true);
  });

  it('changes the address when any locking parameter changes', () => {
    const base = build();

    expect(build({ locktime: 800_001 }).p2wshAddress).not.toEqual(base.p2wshAddress);
    expect(build({ secretHash: 'b'.repeat(64) }).p2wshAddress).not.toEqual(base.p2wshAddress);
  });

  it('accepts uncompressed public keys', () => {
    expect(() => build({ recipientPubKey: `04${'d'.repeat(128)}` })).not.toThrow();
  });

  it('rejects a hashlock that is not 32 bytes', () => {
    expect(() => build({ secretHash: 'ab' })).toThrow(/must be 32 bytes/);
  });

  it('rejects a malformed public key', () => {
    expect(() => build({ senderPubKey: 'abcd' })).toThrow(/33- or 65-byte public key/);
  });

  it('rejects non-hex input', () => {
    expect(() => build({ secretHash: 'z'.repeat(64) })).toThrow(/even-length hex/);
  });

  it('rejects a locktime that is not a positive height', () => {
    expect(() => build({ locktime: 0 })).toThrow(/positive block height/);
    expect(() => build({ locktime: -1 })).toThrow(/positive block height/);
  });

  it('rejects a locktime in the unix-timestamp range', () => {
    // BIP-65 reads values at or above the threshold as timestamps, not heights.
    expect(() => build({ locktime: LOCKTIME_THRESHOLD })).toThrow(/block heights/);
  });
});

describe('encodeScriptNumber', () => {
  it('encodes zero as an empty push', () => {
    expect(encodeScriptNumber(0)).toEqual(Uint8Array.from([]));
  });

  it('encodes little-endian', () => {
    expect(encodeScriptNumber(1)).toEqual(Uint8Array.from([0x01]));
    expect(encodeScriptNumber(256)).toEqual(Uint8Array.from([0x00, 0x01]));
    expect(encodeScriptNumber(800_000)).toEqual(Uint8Array.from([0x00, 0x35, 0x0c]));
  });

  it('pads values whose high bit would read as a sign bit', () => {
    expect(encodeScriptNumber(128)).toEqual(Uint8Array.from([0x80, 0x00]));
  });
});
