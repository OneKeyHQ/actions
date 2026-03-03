const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const core = require('@actions/core');
const axios = require('axios');
const FormData = require('form-data');

const UPLOAD_PATH = '/v1/app-update/bundles/upload';
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes for large files
const VALID_PLATFORMS = ['android', 'ios', 'electron'];
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

function validateInputs({ filePath, appVersion, platform }) {
  // File exists
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  // ZIP magic bytes
  const fd = fs.openSync(filePath, 'r');
  const header = Buffer.alloc(4);
  fs.readSync(fd, header, 0, 4, 0);
  fs.closeSync(fd);
  if (!ZIP_MAGIC.every((b, i) => header[i] === b)) {
    throw new Error(`Invalid file: not a ZIP archive (${filePath})`);
  }

  // App version format
  if (!/^\d+\.\d+\.\d+$/.test(appVersion)) {
    throw new Error(`Invalid app-version format: "${appVersion}" (expected x.y.z)`);
  }

  // Platform
  if (!VALID_PLATFORMS.includes(platform)) {
    throw new Error(`Invalid platform: "${platform}" (expected: ${VALID_PLATFORMS.join(', ')})`);
  }
}

function computeSignature(fileBuffer, secret) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}:${fileHash}`)
    .digest('hex');
  return { timestamp, fileHash, signature };
}

function buildFormData(fileBuffer, filePath, fields) {
  const form = new FormData();
  form.append('file', fileBuffer, {
    filename: path.basename(filePath),
    contentType: 'application/zip',
  });
  form.append('appVersion', fields.appVersion);
  form.append('platform', fields.platform);
  form.append('commitHash', fields.commitHash);
  if (fields.branch) {
    form.append('branch', fields.branch);
  }
  if (fields.prTitle) {
    form.append('prTitle', fields.prTitle);
  }
  return form;
}

async function uploadWithRetry(url, form, headers, maxRetries) {
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      core.info(`Upload attempt ${attempt}/${maxRetries}...`);
      const response = await axios.post(url, form, {
        headers: {
          ...form.getHeaders(),
          ...headers,
        },
        timeout: REQUEST_TIMEOUT_MS,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      });
      return response.data;
    } catch (error) {
      lastError = error;
      const status = error.response?.status;
      const isRetryable =
        !status || // network error (no response)
        status >= 500; // server error

      if (!isRetryable || attempt === maxRetries) {
        throw error;
      }

      const delay = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
      core.warning(
        `Attempt ${attempt} failed (${status || error.code || error.message}), retrying in ${delay / 1000}s...`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

async function run() {
  try {
    // 1. Read inputs
    const serverUrl = core.getInput('server-url', { required: true }).replace(/\/$/, '');
    const secret = core.getInput('upload-secret', { required: true });
    const filePath = core.getInput('file-path', { required: true });
    const appVersion = core.getInput('app-version', { required: true });
    const platform = core.getInput('platform', { required: true });
    const commitHash = core.getInput('commit-hash') || process.env.GITHUB_SHA;
    const branch = core.getInput('branch') || '';
    const prTitle = core.getInput('pr-title') || '';
    const maxRetries = parseInt(core.getInput('max-retries') || '3', 10);

    // 2. Validate
    core.info(`Uploading ${filePath} (platform: ${platform}, version: ${appVersion})`);
    validateInputs({ filePath, appVersion, platform });

    // 3. Read file and compute signature
    const fileBuffer = fs.readFileSync(filePath);
    const fileSizeMB = (fileBuffer.length / (1024 * 1024)).toFixed(2);
    core.info(`File size: ${fileSizeMB} MB`);

    const { timestamp, fileHash, signature } = computeSignature(fileBuffer, secret);
    core.info(`SHA256: ${fileHash}`);

    // 4. Build form data
    const form = buildFormData(fileBuffer, filePath, {
      appVersion,
      platform,
      commitHash,
      branch,
      prTitle,
    });

    // 5. Upload with retry
    const uploadUrl = `${serverUrl}${UPLOAD_PATH}`;
    core.info(`Uploading to ${uploadUrl}`);

    const result = await uploadWithRetry(
      uploadUrl,
      form,
      {
        'X-Bundle-Timestamp': timestamp,
        'X-Bundle-Signature': signature,
      },
      maxRetries
    );

    // 6. Set outputs
    core.setOutput('bundle-version', String(result.bundleVersion));
    core.setOutput('download-url', result.downloadUrl);
    core.setOutput('sha256', result.sha256 || fileHash);
    core.setOutput('file-size', String(result.fileSize || fileBuffer.length));

    core.info(`Upload successful! Bundle version: ${result.bundleVersion}`);
    core.info(`Download URL: ${result.downloadUrl}`);
  } catch (error) {
    const status = error.response?.status;
    const body = error.response?.data;
    if (status) {
      core.error(`Server responded with ${status}: ${JSON.stringify(body)}`);
    }
    core.setFailed(`Upload failed: ${error.message}`);
  }
}

run();
