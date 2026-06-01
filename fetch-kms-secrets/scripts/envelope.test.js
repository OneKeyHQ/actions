'use strict';

// Tests for the OK1 envelope core, the action's decrypt wrapper, the masking
// helper, and the V4 signer. Run: node --test scripts/  (or: npm test)
// Zero deps — only node builtins, matching the action itself.

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const { seal, open } = require('./envelope');
const { decryptSecretBlob, signKmsRequest, maskLines } = require('./fetch-and-decrypt');

const FETCH = path.join(__dirname, 'fetch-and-decrypt.js');

// One 2048-bit keypair for the whole suite (small key on purpose — proves the
// hybrid scheme is not bound by the RSA size limit).
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

// ---- envelope round-trip -------------------------------------------------

test('round-trip: seal -> open returns the original object', () => {
  const obj = { CODACY_PROJECT_TOKEN: 'tok_abc', OTHER: 'second' };
  assert.deepStrictEqual(open(privateKey, seal(publicKey, obj)), obj);
});

test('round-trip preserves newlines and unicode in values', () => {
  const obj = { PEM: '-----BEGIN-----\nline2\n-----END-----', UTF: 'café—✓' };
  assert.deepStrictEqual(open(privateKey, seal(publicKey, obj)), obj);
});

test('the action runtime decrypts exactly what seal produces (no drift)', () => {
  const obj = { A: 'one', B: 'two' };
  const token = seal(publicKey, obj);
  assert.deepStrictEqual(decryptSecretBlob(privateKey, 'secret', token), obj);
});

test('big payload (~5 KB) round-trips on a 2048-bit key', () => {
  const obj = {};
  for (let i = 0; i < 50; i += 1) obj[`KEY_${i}`] = 'x'.repeat(100);
  assert.ok(JSON.stringify(obj).length > 2000);
  assert.deepStrictEqual(open(privateKey, seal(publicKey, obj)), obj);
});

test('token carries the OK1 magic', () => {
  const token = seal(publicKey, { K: 'v' });
  assert.strictEqual(Buffer.from(token, 'base64').subarray(0, 3).toString(), 'OK1');
});

// ---- envelope rejection paths --------------------------------------------

test('tampered ciphertext is rejected by GCM auth', () => {
  const buf = Buffer.from(seal(publicKey, { K: 'v' }), 'base64');
  buf[buf.length - 1] ^= 0xff;
  assert.throws(() => open(privateKey, buf.toString('base64')), /AES-256-GCM decrypt\/auth failed/);
});

test('wrong private key is rejected at RSA unwrap', () => {
  const other = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey;
  assert.throws(() => open(other, seal(publicKey, { K: 'v' })), /RSA-OAEP-SHA256 unwrap .* failed/);
});

test('malformed tokens are rejected with clear messages', () => {
  assert.throws(() => open(privateKey, ''), /token is empty/);
  assert.throws(() => open(privateKey, Buffer.from('OK1').toString('base64')), /too short/);
  const big = Buffer.concat([Buffer.from('NOPE'), Buffer.alloc(40)]).toString('base64');
  assert.throws(() => open(privateKey, big), /expected magic 'OK1'/);
  // valid magic, framing passes, but wrappedKeyLen (0xFFFF) overruns the buffer
  const trunc = Buffer.concat([Buffer.from('OK1'), Buffer.from([0xff, 0xff]), Buffer.alloc(35)]);
  assert.throws(() => open(privateKey, trunc.toString('base64')), /truncated \(wrapped-key length mismatch\)/);
});

test('seal validates the plaintext shape', () => {
  assert.throws(() => seal(publicKey, {}), /is empty/);
  assert.throws(() => seal(publicKey, { K: 123 }), /must be a string/);
  assert.throws(() => seal(publicKey, ['a']), /flat JSON object/);
});

// ---- maskLines (multi-line leak fix) -------------------------------------

test('maskLines masks a single-line value whole, any length', () => {
  assert.deepStrictEqual(maskLines('abc'), ['abc']);
  assert.deepStrictEqual(maskLines('ab'), ['ab']);
  assert.deepStrictEqual(maskLines(''), []);
});

test('maskLines masks each substantial line of a multi-line value', () => {
  const pem = '-----BEGIN KEY-----\nMIIBdummybase64line\n-----END KEY-----';
  assert.deepStrictEqual(maskLines(pem), [
    '-----BEGIN KEY-----',
    'MIIBdummybase64line',
    '-----END KEY-----',
  ]);
  // braces / blank lines are skipped so masking can't corrupt unrelated logs
  assert.deepStrictEqual(maskLines('{\n  "k": "longsecretvalue"\n}\n'), ['  "k": "longsecretvalue"']);
});

// ---- V4 signer structure -------------------------------------------------

test('signKmsRequest emits a well-formed Volcengine V4 Authorization', () => {
  const signed = signKmsRequest({
    sts: { accessKeyId: 'AKtest', secretAccessKey: 'SKtest', sessionToken: 'STStest' },
    region: 'cn-beijing',
    host: 'kms.cn-beijing.volcengineapi.com',
    queryParams: { Action: 'GetSecretValue', Version: '2021-02-18' },
    bodyString: 'SecretName=foo',
  });
  assert.match(
    signed.headers.Authorization,
    /^HMAC-SHA256 Credential=AKtest\/\d{8}\/cn-beijing\/kms\/request, SignedHeaders=content-type;host;x-content-sha256;x-date;x-security-token, Signature=[0-9a-f]{64}$/,
  );
  assert.match(signed.canonicalQuery, /Action=GetSecretValue/);
  assert.strictEqual(signed.headers['X-Security-Token'], 'STStest');
});

// ---- runtime fail-fast (no network reached) ------------------------------

function runRuntime(env) {
  return spawnSync(process.execPath, [FETCH], { env, encoding: 'utf8' });
}

test('runtime fails fast on missing required env', () => {
  const r = runRuntime({ PATH: process.env.PATH });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /missing required env: VOLC_ACCOUNT_ID/);
});

test('runtime rejects an invalid region before any network call', () => {
  const r = runRuntime({
    PATH: process.env.PATH,
    VOLC_ACCOUNT_ID: 'acc',
    VOLC_ROLE_TRN: 'trn',
    VOLC_KMS_REGION: 'evil.com#',
  });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /invalid volc-kms-region/);
});
