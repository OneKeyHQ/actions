'use strict';

// Single source of truth for the fetch-kms-secrets envelope format ("OK1").
// Hybrid encryption — AES-256-GCM seals the JSON payload, RSA-OAEP-SHA256 wraps
// the one-time AES key. Shared by the action runtime (fetch-and-decrypt.js) AND
// the ops CLI (secret-tool.js) so the pack/unpack logic can never drift.
//
// RSA only ever wraps the 32-byte AES key, so the JSON payload has no practical
// size limit (a plain RSA-over-the-whole-blob scheme caps at ~190 B on a
// 2048-bit key). Packed layout (before base64):
//   MAGIC(3) | wrappedKeyLen(2, BE) | wrappedKey(N) | iv(12) | tag(16) | ciphertext
// MAGIC 'OK1' is a format/version marker that also fast-rejects foreign payloads.

const crypto = require('crypto');

const MAGIC = Buffer.from('OK1', 'ascii');
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32; // AES-256
const OAEP = {
  padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
  oaepHash: 'sha256',
};

// Both seal and open require a flat { ENV_KEY: "value" } object with string
// values — the env-injection contract. Throws on any violation.
function assertFlatStringObject(obj, label) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error(`${label} must be a flat JSON object of { ENV_KEY: "value" }`);
  }
  const keys = Object.keys(obj);
  if (keys.length === 0) throw new Error(`${label} is empty`);
  for (const k of keys) {
    if (typeof obj[k] !== 'string') {
      throw new Error(`${label}: value of '${k}' must be a string`);
    }
  }
  return keys;
}

// seal: { K: "v", ... } + RSA public key PEM -> base64 "OK1" token.
function seal(publicKeyPem, obj) {
  assertFlatStringObject(obj, 'plaintext');

  const aesKey = crypto.randomBytes(KEY_BYTES);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(obj), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  const wrappedKey = crypto.publicEncrypt({ key: publicKeyPem, ...OAEP }, aesKey);

  const wrappedKeyLen = Buffer.alloc(2);
  wrappedKeyLen.writeUInt16BE(wrappedKey.length, 0);
  return Buffer.concat([
    MAGIC,
    wrappedKeyLen,
    wrappedKey,
    iv,
    tag,
    ciphertext,
  ]).toString('base64');
}

// open: base64 "OK1" token + RSA private key PEM -> { K: "v", ... }.
// Throws Error with a clear, material-free message on any failure (never echoes
// ciphertext or key bytes — callers may surface the message into logs).
function open(privateKeyPem, token) {
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('token is empty');
  }
  // Buffer.from(.,'base64') is lenient; the MAGIC + length checks below are what
  // actually reject malformed input, so no try/catch is needed here.
  const packed = Buffer.from(token, 'base64');
  const framingBytes = MAGIC.length + 2 + IV_BYTES + TAG_BYTES;
  if (packed.length < framingBytes) {
    throw new Error('token is too short to be a valid envelope');
  }
  if (!packed.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error("unrecognized envelope (expected magic 'OK1')");
  }

  let off = MAGIC.length;
  const wrappedKeyLen = packed.readUInt16BE(off);
  off += 2;
  if (packed.length < off + wrappedKeyLen + IV_BYTES + TAG_BYTES) {
    throw new Error('token is truncated (wrapped-key length mismatch)');
  }
  const wrappedKey = packed.subarray(off, off + wrappedKeyLen);
  off += wrappedKeyLen;
  const iv = packed.subarray(off, off + IV_BYTES);
  off += IV_BYTES;
  const tag = packed.subarray(off, off + TAG_BYTES);
  off += TAG_BYTES;
  const ciphertext = packed.subarray(off);

  let aesKey;
  try {
    aesKey = crypto.privateDecrypt({ key: privateKeyPem, ...OAEP }, wrappedKey);
  } catch (e) {
    throw new Error(`RSA-OAEP-SHA256 unwrap of the AES key failed (${e.message})`);
  }
  if (aesKey.length !== KEY_BYTES) {
    throw new Error('unwrapped AES key is not 256-bit');
  }

  let plaintext;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (e) {
    // GCM auth failure means tampering or wrong key.
    throw new Error(`AES-256-GCM decrypt/auth failed (${e.message})`);
  }

  let obj;
  try {
    obj = JSON.parse(plaintext.toString('utf8'));
  } catch (e) {
    throw new Error('decrypted content is not valid JSON');
  }
  assertFlatStringObject(obj, 'decrypted payload');
  return obj;
}

module.exports = { seal, open };
