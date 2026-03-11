const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const core = require('@actions/core');
const axios = require('axios');
const FormData = require('form-data');

const UPLOAD_PATH = '/utility/v1/app-update/bundles/upload';
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
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

async function uploadWithRetry({ url, fileBuffer, fileName, fields, fileHash, secret, maxRetries, label }) {
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      core.info(`[${label}] Upload attempt ${attempt}/${maxRetries}...`);

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
      return { data: response.data };
    } catch (error) {
      lastError = error;
      const status = error.response?.status;
      const isRetryable = !status || status >= 500;

      if (!isRetryable || attempt === maxRetries) {
        throw error;
      }

      const delay = Math.pow(2, attempt) * 1000;
      core.warning(
        `[${label}] Attempt ${attempt} failed (${status || error.code || error.message}), retrying in ${delay / 1000}s...`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
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
    const maxRetries = parseInt(core.getInput('max-retries') || '3', 10);

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

        const { data: responseBody } = await uploadWithRetry({
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

        if (responseBody.code !== 0) {
          throw new Error(`Server returned error: ${JSON.stringify(responseBody)}`);
        }

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
        const status = error.response?.status;
        const body = error.response?.data;
        if (status) {
          core.error(`[${label}] Server responded with ${status}: ${JSON.stringify(body)}`);
        }
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

module.exports = { scanBundleDir, parseInfoFile, validateZipMagic };

if (require.main === module) {
  run();
}
