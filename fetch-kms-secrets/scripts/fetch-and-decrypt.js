#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';

// Bootstrap CI credentials from Volcengine KMS without storing long-lived
// AK/SK. Flow: GitHub OIDC -> STS AssumeRoleWithOIDC -> temporary creds ->
// KMS GetSecretValue -> hybrid (AES-256-GCM + RSA-OAEP-SHA256) decrypt ->
// JSON k/v -> $GITHUB_ENV.
//
// Runtime env (from action.yml + GitHub):
//   VOLC_ACCOUNT_ID, VOLC_ROLE_TRN, VOLC_KMS_REGION,
//   KMS_SECRET_NAMES (newline-separated), KMS_DECRYPT_PRIVATE_KEY (PEM),
//   ACTIONS_ID_TOKEN_REQUEST_URL / _TOKEN, GITHUB_ENV, GITHUB_OUTPUT.

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const envelope = require('./envelope');

function fail(msg) {
  process.stderr.write(`::error::fetch-kms-secrets: ${msg}\n`);
  process.exit(1);
}

function requireEnv(name) {
  const v = process.env[name];
  if (v === undefined || v === '') fail(`missing required env: ${name}`);
  return v;
}

// GitHub ::add-mask:: is line-oriented: a newline ends the command, so emitting a
// multi-line value as one command would only mask its first line and PRINT the
// rest. Return the lines that must be registered: a single-line value is masked
// whole (any length); a multi-line value (PEM, JSON, ...) is masked per line,
// skipping blank/<4-char lines so masking "{" can't redact unrelated log text.
function maskLines(value) {
  const str = String(value);
  if (!str.includes('\n') && !str.includes('\r')) {
    return str.length > 0 ? [str] : [];
  }
  return str.split(/\r?\n/).filter((line) => line.trim().length >= 4);
}

function mask(value) {
  for (const line of maskLines(value)) {
    process.stdout.write(`::add-mask::${line}\n`);
  }
}

function appendKv(filePath, key, value) {
  const delim = `EOF_${crypto.randomBytes(8).toString('hex')}`;
  fs.appendFileSync(filePath, `${key}<<${delim}\n${value}\n${delim}\n`);
}

function httpRequest({ hostname, path, method, headers, body }) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, port: 443, path, method, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            statusCode: res.statusCode,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// Parse JSON without surfacing the raw response body — this tool moves secret
// material, so remote bodies must never leak into logs.
function parseJson(body, apiLabel, statusCode) {
  try {
    return JSON.parse(body);
  } catch (e) {
    fail(`${apiLabel} returned a non-JSON response (status=${statusCode})`);
    return undefined; // unreachable after process.exit
  }
}

async function mintGithubOidcToken(audience) {
  const reqUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const reqToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!reqUrl || !reqToken) {
    fail(
      "GitHub OIDC env not present. The caller workflow must declare 'permissions.id-token: write'.",
    );
  }
  const u = new URL(reqUrl);
  u.searchParams.set('audience', audience);
  const res = await httpRequest({
    hostname: u.hostname,
    path: u.pathname + u.search,
    method: 'GET',
    headers: { Authorization: `bearer ${reqToken}` },
  });
  if (res.statusCode !== 200) {
    fail(`GitHub OIDC token request failed (status=${res.statusCode})`);
  }
  const json = parseJson(res.body, 'GitHub OIDC', res.statusCode);
  if (!json.value) fail('GitHub OIDC response missing .value field');
  mask(json.value);
  return json.value;
}

// Volcengine Signature V4 — HMAC-SHA256 derivation chain identical in shape to
// AWS SigV4 (https://www.volcengine.com/docs/6369/67269). Specialized to the
// single call this action makes: POST kms / path "/" with STS session token.
function signKmsRequest({ sts, region, host, queryParams, bodyString }) {
  // 20260101T000000Z form, no separators.
  const amzDate = new Date()
    .toISOString()
    .replace(/[:-]/g, '')
    .replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);

  const canonicalQuery = Object.keys(queryParams)
    .sort()
    .map(
      (k) =>
        `${encodeURIComponent(k)}=${encodeURIComponent(queryParams[k])}`,
    )
    .join('&');

  const payloadHash = crypto
    .createHash('sha256')
    .update(bodyString || '')
    .digest('hex');

  const headersObj = {
    'content-type': 'application/x-www-form-urlencoded',
    host,
    'x-content-sha256': payloadHash,
    'x-date': amzDate,
    'x-security-token': sts.sessionToken,
  };
  const sortedNames = Object.keys(headersObj).sort();
  const canonicalHeaders =
    sortedNames.map((n) => `${n}:${headersObj[n]}`).join('\n') + '\n';
  const signedHeaders = sortedNames.join(';');

  const canonicalRequest = [
    'POST',
    '/',
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${region}/kms/request`;
  const stringToSign = [
    'HMAC-SHA256',
    amzDate,
    credentialScope,
    crypto.createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');

  const hmac = (key, data) =>
    crypto.createHmac('sha256', key).update(data).digest();
  const kDate = hmac(sts.secretAccessKey, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, 'kms');
  const kSigning = hmac(kService, 'request');
  const signature = crypto
    .createHmac('sha256', kSigning)
    .update(stringToSign)
    .digest('hex');

  return {
    canonicalQuery,
    headers: {
      Authorization:
        `HMAC-SHA256 Credential=${sts.accessKeyId}/${credentialScope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Host: host,
      'X-Date': amzDate,
      'X-Content-Sha256': payloadHash,
      'X-Security-Token': sts.sessionToken,
    },
  };
}

// STS AssumeRoleWithOIDC is unsigned — the caller has no credentials yet.
// https://www.volcengine.com/docs/6257/64974
// Action + Version MUST be query params: the gateway reads them from the query
// string to identify this as the anonymous OIDC operation. Putting them only in
// the body makes the gateway demand a V4-signed Authorization header and reject
// with "InvalidCredential". Body carries the operation params only (no
// OIDCTokenType) — matches the proven OneKey backend (utils/secrets/volcengine-oidc).
async function assumeRoleWithOIDC({ roleTrn, oidcToken }) {
  const body = new URLSearchParams({
    RoleTrn: roleTrn,
    RoleSessionName: `gh-actions-${process.env.GITHUB_RUN_ID || 'unknown'}`,
    OIDCToken: oidcToken,
    DurationSeconds: '3600',
  }).toString();

  const res = await httpRequest({
    hostname: 'sts.volcengineapi.com',
    path: '/?Action=AssumeRoleWithOIDC&Version=2018-01-01',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    },
    body,
  });

  const json = parseJson(res.body, 'STS AssumeRoleWithOIDC', res.statusCode);
  if (res.statusCode !== 200 || !json.Result || !json.Result.Credentials) {
    const err = json && json.ResponseMetadata && json.ResponseMetadata.Error;
    fail(
      `STS AssumeRoleWithOIDC failed (${(err && err.Code) || 'unknown'}): ` +
        `${(err && err.Message) || `status=${res.statusCode}`}. ` +
        `Verify trust policy oidc:sub / oidc:aud / oidc:job_workflow_ref.`,
    );
  }

  const c = json.Result.Credentials;
  mask(c.AccessKeyId);
  mask(c.SecretAccessKey);
  mask(c.SessionToken);
  return {
    accessKeyId: c.AccessKeyId,
    secretAccessKey: c.SecretAccessKey,
    sessionToken: c.SessionToken,
  };
}

// KMS GetSecretValue. https://www.volcengine.com/docs/6498 — verify Action /
// Version against the region's current API doc before rollout.
async function getKmsSecretValue({ sts, region, secretName }) {
  const host = `kms.${region}.volcengineapi.com`;
  const queryParams = { Action: 'GetSecretValue', Version: '2021-02-18' };
  const bodyString = new URLSearchParams({ SecretName: secretName }).toString();
  const signed = signKmsRequest({ sts, region, host, queryParams, bodyString });

  const res = await httpRequest({
    hostname: host,
    path: `/?${signed.canonicalQuery}`,
    method: 'POST',
    headers: {
      ...signed.headers,
      'Content-Length': Buffer.byteLength(bodyString),
    },
    body: bodyString,
  });

  const json = parseJson(
    res.body,
    `KMS GetSecretValue(${secretName})`,
    res.statusCode,
  );
  if (
    res.statusCode !== 200 ||
    !json.Result ||
    json.Result.SecretValue === undefined
  ) {
    const err = json && json.ResponseMetadata && json.ResponseMetadata.Error;
    fail(
      `KMS GetSecretValue failed for '${secretName}' (${(err && err.Code) || 'unknown'}): ` +
        `${(err && err.Message) || `status=${res.statusCode}`}. ` +
        `Check the secret exists in '${region}' and the role has kms:GetSecretValue on it.`,
    );
  }
  return json.Result.SecretValue;
}

// Decrypt one KMS SecretValue (the "OK1" hybrid envelope) into its { ENV_KEY:
// value } object. The format lives in ./envelope, shared with scripts/secret-tool.js
// so the action and the ops tool can never drift. envelope.open never echoes
// ciphertext or key material, so it is safe to surface its message into logs.
function decryptSecretBlob(privateKeyPem, secretName, secretValueStr) {
  try {
    return envelope.open(privateKeyPem, secretValueStr);
  } catch (e) {
    fail(
      `SecretValue of '${secretName}': ${e.message}. ` +
        `Confirm it was produced by scripts/secret-tool.js and that ` +
        `decrypt-private-key matches the encrypting public key.`,
    );
  }
  return undefined; // unreachable after process.exit
}

async function main() {
  const accountId = requireEnv('VOLC_ACCOUNT_ID');
  const roleTrn = requireEnv('VOLC_ROLE_TRN');
  const region = requireEnv('VOLC_KMS_REGION');
  // region is interpolated into the KMS hostname (kms.<region>.volcengineapi.com)
  // and the signed Host header — constrain it so a malformed value can't redirect
  // the call (with the live STS session token) to an attacker-controlled host.
  if (!/^[a-z0-9-]+$/.test(region)) {
    fail(`invalid volc-kms-region '${region}' (allowed: lowercase letters, digits, hyphens)`);
  }
  const privateKey = requireEnv('KMS_DECRYPT_PRIVATE_KEY');
  const secretNames = requireEnv('KMS_SECRET_NAMES')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (secretNames.length === 0) fail('secret-names is empty after trimming');

  const githubEnv = requireEnv('GITHUB_ENV');
  const githubOutput = requireEnv('GITHUB_OUTPUT');

  const oidcToken = await mintGithubOidcToken(accountId);
  const sts = await assumeRoleWithOIDC({ roleTrn, oidcToken });

  const fetchedKeys = [];
  for (const secretName of secretNames) {
    const data = decryptSecretBlob(
      privateKey,
      secretName,
      await getKmsSecretValue({ sts, region, secretName }),
    );
    for (const fieldKey of Object.keys(data)) {
      const value = data[fieldKey];
      mask(value);
      appendKv(githubEnv, fieldKey, value);
      fetchedKeys.push(fieldKey);
    }
  }

  appendKv(githubOutput, 'fetched-keys', JSON.stringify(fetchedKeys));
  console.log(`[fetch-kms-secrets] fetched ${fetchedKeys.length} key(s)`);
}

// Run only when invoked directly (the action). Requiring the file as a module
// (tests) exposes the pure functions without triggering the network flow.
if (require.main === module) {
  main().catch((err) => {
    fail(`unexpected error: ${err && err.message ? err.message : err}`);
  });
}

module.exports = { decryptSecretBlob, signKmsRequest, maskLines };
