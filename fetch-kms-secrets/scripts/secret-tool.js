#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';

// Ops CLI for the fetch-kms-secrets "OK1" envelope. The pack/unpack format is
// shared with the action runtime via ./envelope, so what this tool encrypts is
// exactly what the action decrypts.
//
//   keygen  [out-dir] [--bits N]      generate a paired RSA keypair (default 4096)
//   encrypt <public-key.pem>  [json]  seal { ENV_KEY: "value" } JSON -> OK1 token
//   decrypt <private-key.pem> [token] open an OK1 token -> JSON (LOCAL USE ONLY)
//
// JSON / token are read from the file arg, or from stdin when the arg is omitted.
//
// Flow:
//   1. keygen  -> kms-decrypt-private.pem (GitHub Secret) + kms-encrypt-public.pem
//   2. encrypt -> upload the token as the KMS secret value
//   3. decrypt -> offline round-trip check (prints PLAINTEXT — never in CI logs)

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const envelope = require('./envelope');

const PRIVATE_NAME = 'kms-decrypt-private.pem';
const PUBLIC_NAME = 'kms-encrypt-public.pem';
const MIN_BITS = 2048;

function die(msg) {
  process.stderr.write(`secret-tool: ${msg}\n`);
  process.exit(1);
}

function readInput(fileArg, what) {
  // File arg, or stdin (fd 0) when omitted.
  try {
    return fileArg ? fs.readFileSync(fileArg, 'utf8') : fs.readFileSync(0, 'utf8');
  } catch (e) {
    die(`cannot read ${what}: ${e.message}`);
  }
  return ''; // unreachable
}

function parseKeygenArgs(args) {
  let bits = 4096;
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--bits') {
      bits = parseInt(args[(i += 1)], 10);
    } else if (args[i].startsWith('--bits=')) {
      bits = parseInt(args[i].slice('--bits='.length), 10);
    } else {
      positional.push(args[i]);
    }
  }
  if (!Number.isInteger(bits) || bits < MIN_BITS) {
    die(`--bits must be an integer >= ${MIN_BITS}`);
  }
  return { bits, outDir: positional[0] || '.' };
}

function keygen(args) {
  const { bits, outDir } = parseKeygenArgs(args);
  try {
    fs.mkdirSync(outDir, { recursive: true });
  } catch (e) {
    die(`cannot create out-dir '${outDir}': ${e.message}`);
  }
  const privPath = path.join(outDir, PRIVATE_NAME);
  const pubPath = path.join(outDir, PUBLIC_NAME);
  // Refuse to clobber existing keys — overwriting a private key is unrecoverable.
  for (const p of [privPath, pubPath]) {
    if (fs.existsSync(p)) die(`refusing to overwrite existing ${p}`);
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: bits,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  fs.writeFileSync(privPath, privateKey, { mode: 0o600 });
  fs.chmodSync(privPath, 0o600); // enforce even if umask widened the create mode
  fs.writeFileSync(pubPath, publicKey, { mode: 0o644 });

  process.stderr.write(
    `wrote ${privPath} (mode 600) and ${pubPath} (RSA-${bits})\n` +
      `  • put ${PRIVATE_NAME} into GitHub Secret KMS_DECRYPT_PRIVATE_KEY — never commit it\n` +
      `  • encrypt KMS values with ${PUBLIC_NAME}\n`,
  );
}

function encrypt(args) {
  const [pubKeyPath, jsonPath] = args;
  if (!pubKeyPath) die('usage: secret-tool encrypt <public-key.pem> [plaintext.json]');
  const publicKeyPem = readInput(pubKeyPath, 'public key');
  const raw = readInput(jsonPath, 'plaintext JSON');

  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    die('plaintext is not valid JSON');
  }
  let token;
  try {
    token = envelope.seal(publicKeyPem, obj);
  } catch (e) {
    die(e.message);
  }
  process.stdout.write(`${token}\n`);
}

function decrypt(args) {
  const [privKeyPath, tokenPath] = args;
  if (!privKeyPath) die('usage: secret-tool decrypt <private-key.pem> [token.txt]');
  const privateKeyPem = readInput(privKeyPath, 'private key');
  const token = readInput(tokenPath, 'token').trim();

  let obj;
  try {
    obj = envelope.open(privateKeyPem, token);
  } catch (e) {
    die(e.message);
  }
  // This reveals plaintext secrets — intended for local round-trip checks only.
  process.stderr.write('secret-tool: decrypt output is PLAINTEXT — do not run in CI logs\n');
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case 'keygen':
      return keygen(rest);
    case 'encrypt':
      return encrypt(rest);
    case 'decrypt':
      return decrypt(rest);
    default:
      return die(
        'usage: secret-tool <keygen|encrypt|decrypt> ...\n' +
          '  keygen  [out-dir] [--bits N]\n' +
          '  encrypt <public-key.pem>  [plaintext.json]\n' +
          '  decrypt <private-key.pem> [token.txt]',
      );
  }
}

main();
