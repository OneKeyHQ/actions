const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const core = require('@actions/core');
const axios = require('axios');
const FormData = require('form-data');

const UPLOAD_PATH = '/utility/v1/app-update/bundles/upload';
// Healthy uploads finish in well under 10s and the gateway in front of the
// server gives up after ~30s, so this only bounds a connection that never answers.
const REQUEST_TIMEOUT_MS = 2 * 60 * 1000;
const RETRY_BASE_DELAY_MS = 2 * 1000;
const RETRY_MAX_DELAY_MS = 30 * 1000;
// The utility server answers application errors with HTTP 200 and `{ code, message }`.
// 40000 is its uncaught-error code ("Something went wrong. Try again.").
const SERVER_UNCAUGHT_ERROR_CODE = 40000;
// Response headers that let the server side find a failed request in edge logs.
const TRACE_HEADERS = ['cf-ray', 'x-request-id', 'server'];
const VALID_PLATFORMS = ['android', 'ios', 'electron'];
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const INFO_REQUIRED_FIELDS = ['appVersion', 'appType', 'sha256'];

function scanBundleDir(dirPath) {
  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
    throw new Error(`bundle-dir not found or not a directory: ${dirPath}`);
  }

  const entries = fs.readdirSync(dirPath);
  const zipFiles = entries.filter((f) => f.endsWith('-bundle.zip'));

  if (zipFiles.length === 0) {
    throw new Error(`No bundle ZIP files found in ${dirPath}`);
  }

  return zipFiles.map((zipName) => {
    const baseName = zipName.replace(/-bundle\.zip$/, '');
    const candidates = [`${baseName}-bundle.zip.info`, `${baseName}-bundle.json.info`];
    const infoName = candidates.find((c) => entries.includes(c));

    if (!infoName) {
      throw new Error(`${zipName}: no matching .info file (tried ${candidates.join(', ')})`);
    }

    return {
      zipPath: path.join(dirPath, zipName),
      infoPath: path.join(dirPath, infoName),
    };
  });
}

function parseInfoFile(infoPath) {
  let raw;
  let content;
  try {
    content = fs.readFileSync(infoPath, 'utf8');
  } catch (e) {
    throw new Error(`${path.basename(infoPath)}: cannot read file — ${e.message}`);
  }
  try {
    raw = JSON.parse(content);
  } catch (e) {
    throw new Error(`${path.basename(infoPath)}: invalid JSON — ${e.message}`);
  }

  for (const field of INFO_REQUIRED_FIELDS) {
    if (!raw[field]) {
      throw new Error(`${path.basename(infoPath)}: missing required field "${field}"`);
    }
  }

  if (!/^[0-9a-f]{64}$/i.test(raw.sha256)) {
    throw new Error(`${path.basename(infoPath)}: invalid sha256 format`);
  }

  if (!/^\d+\.\d+\.\d+$/.test(raw.appVersion)) {
    throw new Error(`${path.basename(infoPath)}: invalid appVersion format "${raw.appVersion}" (expected x.y.z)`);
  }

  if (!VALID_PLATFORMS.includes(raw.appType)) {
    throw new Error(
      `${path.basename(infoPath)}: invalid appType "${raw.appType}" (expected: ${VALID_PLATFORMS.join(', ')})`
    );
  }

  return {
    appVersion: raw.appVersion,
    platform: raw.appType,
    sha256: raw.sha256,
    fileName: raw.fileName,
    size: raw.size,
    buildNumber: raw.buildNumber || '',
    bundleVersion: raw.bundleVersion || '',
  };
}

function validateZipMagic(fileBuffer, label) {
  if (!ZIP_MAGIC.every((b, i) => fileBuffer[i] === b)) {
    throw new Error(`${label}: not a valid ZIP archive`);
  }
}

function computeSignature(fileHash, secret) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}:${fileHash}`)
    .digest('hex');
  return { timestamp, signature };
}

function buildFormData(fileBuffer, fileName, fields) {
  const form = new FormData();
  form.append('file', fileBuffer, {
    filename: fileName,
    contentType: 'application/zip',
  });
  form.append('appVersion', fields.appVersion);
  form.append('platform', fields.platform);
  if (fields.commitHash) {
    form.append('commitHash', fields.commitHash);
  }
  if (fields.branch) {
    form.append('branch', fields.branch);
  }
  if (fields.prTitle) {
    form.append('prTitle', fields.prTitle);
  }
  if (fields.buildNumber) {
    form.append('buildNumber', fields.buildNumber);
  }
  if (fields.bundleVersion) {
    form.append('bundleVersion', fields.bundleVersion);
  }
  return form;
}

class ServerResponseError extends Error {
  constructor(body) {
    super(`Server returned error: ${JSON.stringify(body)}`);
    this.name = 'ServerResponseError';
    this.body = body;
  }
}

// Non-2xx statuses never come from the utility app itself (see
// SERVER_UNCAUGHT_ERROR_CODE); they come from the edge in front of it. The
// gateway answers 408 when it stops waiting for the request body and 5xx/52x
// when the connection is reset. No status means a network error or client
// timeout. Retrying is safe: the server keys bundles by commit hash and
// overwrites the same storage object.
function isRetryableError(error) {
  if (error instanceof ServerResponseError) {
    return error.body?.code === SERVER_UNCAUGHT_ERROR_CODE;
  }
  const status = error.response?.status;
  return !status || status === 408 || status >= 500;
}

function getRetryDelayMs(attempt, baseDelayMs = RETRY_BASE_DELAY_MS) {
  const backoff = Math.min(baseDelayMs * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS);
  // Jitter keeps the parallel iOS/Android/desktop jobs from retrying in lockstep.
  return Math.round(backoff * (0.5 + Math.random() * 0.5));
}

function describeFailure(error) {
  const { response } = error;
  if (error instanceof ServerResponseError || !response) {
    return error.code ? `${error.code}: ${error.message}` : error.message;
  }
  const raw = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
  const body = raw?.replace(/\s+/g, ' ').trim();
  const trace = TRACE_HEADERS.filter((name) => response.headers?.[name]).map(
    (name) => `${name}=${response.headers[name]}`
  );
  return [`HTTP ${response.status}`, body && `body=${body.slice(0, 200)}`, ...trace].filter(Boolean).join(', ');
}

async function uploadWithRetry({
  url,
  fileBuffer,
  fileName,
  fields,
  fileHash,
  secret,
  maxRetries,
  label,
  baseDelayMs = RETRY_BASE_DELAY_MS,
}) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    core.info(`[${label}] Upload attempt ${attempt}/${maxRetries}...`);
    const startedAt = Date.now();

    try {
      const { timestamp, signature } = computeSignature(fileHash, secret);
      const form = buildFormData(fileBuffer, fileName, fields);

      const requestHeaders = {
        ...form.getHeaders(),
        'X-Bundle-Timestamp': timestamp,
        'X-Bundle-Signature': signature,
      };

      core.info(`[${label}] Request URL: ${url}`);
      const safeHeaders = { ...requestHeaders, 'X-Bundle-Signature': requestHeaders['X-Bundle-Signature'].slice(0, 8) + '...' };
      core.info(`[${label}] Request headers: ${JSON.stringify(safeHeaders, null, 2)}`);

      const response = await axios.post(url, form, {
        headers: requestHeaders,
        timeout: REQUEST_TIMEOUT_MS,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      });

      if (response.data?.code !== 0) {
        throw new ServerResponseError(response.data);
      }
      return response.data;
    } catch (error) {
      const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      const summary = `${describeFailure(error)} (after ${elapsedSeconds}s)`;

      if (!isRetryableError(error)) {
        throw new Error(`attempt ${attempt}/${maxRetries} failed with a non-retryable error: ${summary}`);
      }
      if (attempt === maxRetries) {
        throw new Error(`all ${maxRetries} attempts failed, last error: ${summary}`);
      }

      const delay = getRetryDelayMs(attempt, baseDelayMs);
      core.warning(
        `[${label}] Attempt ${attempt}/${maxRetries} failed: ${summary}. Retrying in ${(delay / 1000).toFixed(1)}s...`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw new Error(`Invalid max-retries: ${maxRetries}`);
}

async function run() {
  try {
    const serverUrl = core.getInput('server-url', { required: true }).replace(/\/$/, '');
    const secret = core.getInput('upload-secret', { required: true });
    core.setSecret(secret);
    const bundleDir = core.getInput('bundle-dir', { required: true });
    const commitHash = core.getInput('commit-hash') || process.env.GITHUB_SHA;
    const branch = core.getInput('branch') || '';
    const prTitle = core.getInput('pr-title') || '';
    const maxRetries = parseInt(core.getInput('max-retries') || '5', 10);

    if (Number.isNaN(maxRetries) || maxRetries < 1) {
      throw new Error(`Invalid max-retries: "${core.getInput('max-retries')}" (expected positive integer)`);
    }

    core.info(`Scanning ${bundleDir} for bundles...`);
    const bundles = scanBundleDir(bundleDir);
    core.info(`Found ${bundles.length} bundle(s): ${bundles.map((b) => path.basename(b.zipPath)).join(', ')}`);

    const uploadUrl = `${serverUrl}${UPLOAD_PATH}`;
    const results = [];
    let hasFailure = false;

    for (const bundle of bundles) {
      let meta;
      try {
        meta = parseInfoFile(bundle.infoPath);
      } catch (error) {
        hasFailure = true;
        core.error(`[${path.basename(bundle.infoPath)}] ${error.message}`);
        continue;
      }
      const label = meta.platform;

      try {
        const fileBuffer = fs.readFileSync(bundle.zipPath);
        validateZipMagic(fileBuffer, label);

        const fileSizeMB = (fileBuffer.length / (1024 * 1024)).toFixed(2);
        core.info(`[${label}] Uploading ${path.basename(bundle.zipPath)} (${fileSizeMB} MB, v${meta.appVersion})...`);

        const computedHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
        if (computedHash !== meta.sha256.toLowerCase()) {
          throw new Error(`SHA256 mismatch: computed ${computedHash}, .info says ${meta.sha256}`);
        }
        core.info(`[${label}] SHA256: ${computedHash}`);

        const responseBody = await uploadWithRetry({
          url: uploadUrl,
          fileBuffer,
          fileName: path.basename(bundle.zipPath),
          fields: {
            appVersion: meta.appVersion,
            platform: meta.platform,
            commitHash,
            branch,
            prTitle,
            buildNumber: meta.buildNumber,
            bundleVersion: meta.bundleVersion,
          },
          fileHash: computedHash,
          secret,
          maxRetries,
          label,
        });

        const result = responseBody.data;
        if (!result || !result.bundleVersion || !result.downloadUrl) {
          throw new Error(`Server response missing required fields: ${JSON.stringify(responseBody)}`);
        }

        const entry = {
          platform: meta.platform,
          bundleVersion: String(result.bundleVersion),
          downloadUrl: result.downloadUrl,
          sha256: result.sha256 || computedHash,
          fileSize: String(result.fileSize || fileBuffer.length),
        };
        results.push(entry);

        core.info(`[${label}] Upload successful! Bundle version: ${entry.bundleVersion}`);
        core.info(`[${label}] Download URL: ${entry.downloadUrl}`);
      } catch (error) {
        hasFailure = true;
        core.error(`[${label}] Upload failed: ${error.message}`);
      }
    }

    core.setOutput('results', JSON.stringify(results));

    if (hasFailure) {
      core.setFailed(`One or more bundles failed to upload. ${results.length}/${bundles.length} succeeded.`);
    } else {
      core.info(`All ${results.length} bundle(s) uploaded successfully.`);
    }
  } catch (error) {
    core.setFailed(`Upload failed: ${error.message}`);
  }
}

module.exports = {
  scanBundleDir,
  parseInfoFile,
  validateZipMagic,
  uploadWithRetry,
  isRetryableError,
  getRetryDelayMs,
  ServerResponseError,
};

if (require.main === module) {
  run();
}
