'use strict';

// Tests for the ops CLI (keygen / encrypt / decrypt) by spawning it as a real
// process. Run: node --test scripts/  (or: npm test)

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TOOL = path.join(__dirname, 'secret-tool.js');

function tool(args, input) {
  return spawnSync(process.execPath, [TOOL, ...args], { input, encoding: 'utf8' });
}
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
}
const PRIV = 'kms-decrypt-private.pem';
const PUB = 'kms-encrypt-public.pem';

test('keygen writes a 0600 private key and a public key', () => {
  const dir = tmpDir();
  const r = tool(['keygen', dir, '--bits', '2048']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(fs.statSync(path.join(dir, PRIV)).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(path.join(dir, PRIV), 'utf8'), /PRIVATE KEY/);
  assert.match(fs.readFileSync(path.join(dir, PUB), 'utf8'), /PUBLIC KEY/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('keygen creates a missing nested out-dir instead of crashing', () => {
  const base = tmpDir();
  const nested = path.join(base, 'a', 'b', 'keys');
  const r = tool(['keygen', nested]); // default 4096
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(nested, PRIV)));
  fs.rmSync(base, { recursive: true, force: true });
});

test('keygen refuses to overwrite existing keys', () => {
  const dir = tmpDir();
  assert.strictEqual(tool(['keygen', dir, '--bits', '2048']).status, 0);
  const r = tool(['keygen', dir, '--bits', '2048']);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /refusing to overwrite/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('keygen rejects keys weaker than 2048 bits', () => {
  const dir = tmpDir();
  const r = tool(['keygen', dir, '--bits', '1024']);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, />= 2048/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('encrypt | decrypt round-trips via the CLI (stdin)', () => {
  const dir = tmpDir();
  tool(['keygen', dir, '--bits', '2048']);
  const payload = { CODACY_PROJECT_TOKEN: 'hello-123', OTHER: 'x'.repeat(80) };
  const enc = tool(['encrypt', path.join(dir, PUB)], JSON.stringify(payload));
  assert.strictEqual(enc.status, 0, enc.stderr);
  const dec = tool(['decrypt', path.join(dir, PRIV)], enc.stdout.trim());
  assert.strictEqual(dec.status, 0, dec.stderr);
  assert.deepStrictEqual(JSON.parse(dec.stdout), payload);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('decrypt rejects a tampered token', () => {
  const dir = tmpDir();
  tool(['keygen', dir, '--bits', '2048']);
  const token = tool(['encrypt', path.join(dir, PUB)], JSON.stringify({ K: 'v' })).stdout.trim();
  const buf = Buffer.from(token, 'base64');
  buf[buf.length - 1] ^= 0xff;
  const dec = tool(['decrypt', path.join(dir, PRIV)], buf.toString('base64'));
  assert.notStrictEqual(dec.status, 0);
  assert.match(dec.stderr, /AES-256-GCM decrypt\/auth failed/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('encrypt rejects non-JSON plaintext', () => {
  const dir = tmpDir();
  tool(['keygen', dir, '--bits', '2048']);
  const r = tool(['encrypt', path.join(dir, PUB)], 'not json');
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /not valid JSON/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('unknown command prints usage and exits non-zero', () => {
  const r = tool(['bogus']);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /usage: secret-tool/);
});
