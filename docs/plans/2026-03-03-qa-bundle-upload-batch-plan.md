# QA Bundle Upload Batch Mode Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rewrite qa-bundle-upload action to accept a directory of bundle ZIPs + .info metadata files, automatically scanning, reading metadata, and uploading each bundle serially.

**Architecture:** Replace single-file mode entirely. Action reads `bundle-dir`, scans for `*-bundle.zip` files, matches each to a `.info` metadata file, extracts `appVersion`/`platform`/`sha256` from `.info`, then uploads each bundle via HMAC-signed multipart POST. Existing `computeSignature`, `buildFormData`, `uploadWithRetry` functions are preserved with minor signature changes.

**Tech Stack:** Node.js 20, @actions/core, axios, form-data, @vercel/ncc

**Design doc:** `docs/plans/2026-03-03-qa-bundle-upload-batch-design.md`

---

### Task 1: Update action.yml

**Files:**
- Modify: `qa-bundle-upload/action.yml`

**Step 1: Replace inputs and outputs**

Replace the entire file content with:

```yaml
name: 'QA Bundle Upload'
description: 'Scan a directory for bundle ZIPs + .info metadata, then upload each to Utility server via HMAC-signed multipart POST'
branding:
  icon: 'upload-cloud'
  color: 'green'
inputs:
  server-url:
    description: 'Utility server URL, e.g. https://utility.onekey.so'
    required: true
  upload-secret:
    description: 'HMAC-SHA256 signing secret (JS_BUNDLE_UPLOAD_SECRET)'
    required: true
  bundle-dir:
    description: 'Directory containing *-bundle.zip and *.info files'
    required: true
  commit-hash:
    description: 'Git commit hash'
    required: false
    default: ${{ github.sha }}
  branch:
    description: 'Git branch name'
    required: false
  pr-title:
    description: 'Pull request title'
    required: false
  max-retries:
    description: 'Maximum retry attempts (including first try)'
    required: false
    default: '3'
outputs:
  results:
    description: 'JSON array of upload results: [{ platform, bundleVersion, downloadUrl, sha256, fileSize }]'
runs:
  using: 'node20'
  main: 'dist/index.js'
```

**Step 2: Commit**

```bash
git add qa-bundle-upload/action.yml
git commit -m "refactor(qa-bundle-upload): update action.yml for batch directory mode

Remove file-path, app-version, platform inputs. Add bundle-dir input.
Replace per-file outputs with single results JSON array output."
```

---

### Task 2: Create test fixtures

**Files:**
- Create: `qa-bundle-upload/test/fixtures/native-bundles/android-bundle.zip`
- Create: `qa-bundle-upload/test/fixtures/native-bundles/android-bundle.zip.info`
- Create: `qa-bundle-upload/test/fixtures/native-bundles/ios-bundle.zip`
- Create: `qa-bundle-upload/test/fixtures/native-bundles/ios-bundle.zip.info`
- Create: `qa-bundle-upload/test/fixtures/desktop-bundle/electron-bundle.zip`
- Create: `qa-bundle-upload/test/fixtures/desktop-bundle/electron-bundle.json.info`
- Create: `qa-bundle-upload/test/scan.test.js`

**Step 1: Create minimal ZIP test fixtures**

Create a script to generate tiny valid ZIP files with correct magic bytes and matching .info files:

```bash
cd qa-bundle-upload
mkdir -p test/fixtures/native-bundles test/fixtures/desktop-bundle
```

```javascript
// test/create-fixtures.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Minimal valid ZIP (empty archive): PK\x05\x06 + 18 zero bytes
const ZIP_HEADER = Buffer.from([
  0x50, 0x4b, 0x03, 0x04, // local file header signature
  0x14, 0x00, 0x00, 0x00, 0x08, 0x00, // version, flags, compression
  0x00, 0x00, 0x00, 0x00, // mod time/date
  0x00, 0x00, 0x00, 0x00, // crc-32
  0x02, 0x00, 0x00, 0x00, // compressed size
  0x00, 0x00, 0x00, 0x00, // uncompressed size
  0x01, 0x00, 0x00, 0x00, // filename length, extra length
  0x78,                    // filename 'x'
  0x03, 0x00,              // compressed data (empty deflate)
  0x50, 0x4b, 0x01, 0x02, // central directory
  0x14, 0x00, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00,
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
  0x02, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
  0x78,                    // filename 'x'
  0x50, 0x4b, 0x05, 0x06, // end of central directory
  0x00, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x01, 0x00,
  0x2f, 0x00, 0x00, 0x00,
  0x25, 0x00, 0x00, 0x00,
  0x00, 0x00,
]);

function createBundle(dir, name, platform) {
  const zipPath = path.join(dir, `${name}-bundle.zip`);
  // Each platform gets slightly different content so SHA256 differs
  const content = Buffer.concat([ZIP_HEADER, Buffer.from(platform)]);
  fs.writeFileSync(zipPath, content);

  const sha256 = crypto.createHash('sha256').update(content).digest('hex');

  const infoSuffix = platform === 'electron' ? '.json.info' : '.zip.info';
  const infoPath = path.join(dir, `${name}-bundle${infoSuffix}`);
  const info = {
    fileName: `${name}-bundle.zip`,
    sha256,
    size: content.length,
    generatedAt: new Date().toISOString(),
    appType: platform,
    appVersion: '6.1.0',
    buildNumber: '2026030235',
    bundleVersion: '2',
  };
  fs.writeFileSync(infoPath, JSON.stringify(info, null, 2));
  console.log(`Created ${zipPath} (${content.length} bytes, sha256: ${sha256.slice(0, 12)}...)`);
  console.log(`Created ${infoPath}`);
}

const nativeDir = path.join(__dirname, 'fixtures/native-bundles');
const desktopDir = path.join(__dirname, 'fixtures/desktop-bundle');

createBundle(nativeDir, 'android', 'android');
createBundle(nativeDir, 'ios', 'ios');
createBundle(desktopDir, 'electron', 'electron');

console.log('\nFixtures created successfully.');
```

Run:

```bash
cd qa-bundle-upload && node test/create-fixtures.js
```

**Step 2: Write scan + parse unit tests**

```javascript
// test/scan.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// Will test scanBundleDir and parseInfoFile once implemented
// For now, verify fixtures exist and are well-formed
const fs = require('fs');

describe('test fixtures', () => {
  const nativeDir = path.join(__dirname, 'fixtures/native-bundles');
  const desktopDir = path.join(__dirname, 'fixtures/desktop-bundle');

  it('native dir has android + ios bundles with .info', () => {
    assert.ok(fs.existsSync(path.join(nativeDir, 'android-bundle.zip')));
    assert.ok(fs.existsSync(path.join(nativeDir, 'android-bundle.zip.info')));
    assert.ok(fs.existsSync(path.join(nativeDir, 'ios-bundle.zip')));
    assert.ok(fs.existsSync(path.join(nativeDir, 'ios-bundle.zip.info')));
  });

  it('desktop dir has electron bundle with .json.info', () => {
    assert.ok(fs.existsSync(path.join(desktopDir, 'electron-bundle.zip')));
    assert.ok(fs.existsSync(path.join(desktopDir, 'electron-bundle.json.info')));
  });

  it('ZIP files start with magic bytes', () => {
    const buf = fs.readFileSync(path.join(nativeDir, 'android-bundle.zip'));
    assert.equal(buf[0], 0x50); // P
    assert.equal(buf[1], 0x4b); // K
    assert.equal(buf[2], 0x03);
    assert.equal(buf[3], 0x04);
  });

  it('.info files contain valid JSON with required fields', () => {
    const info = JSON.parse(fs.readFileSync(path.join(nativeDir, 'android-bundle.zip.info'), 'utf8'));
    assert.ok(info.appVersion);
    assert.ok(info.appType);
    assert.ok(info.sha256);
    assert.ok(info.fileName);
  });
});
```

**Step 3: Run fixture tests**

```bash
cd qa-bundle-upload && node --test test/scan.test.js
```

Expected: all 4 tests pass.

**Step 4: Commit**

```bash
git add qa-bundle-upload/test/
git commit -m "test(qa-bundle-upload): add fixtures and initial tests for batch mode"
```

---

### Task 3: Implement scanBundleDir and parseInfoFile

**Files:**
- Modify: `qa-bundle-upload/src/index.js`
- Modify: `qa-bundle-upload/test/scan.test.js`

**Step 1: Add failing tests for scanBundleDir and parseInfoFile**

Append to `test/scan.test.js`:

```javascript
// Import the functions (we'll export them from index.js for testing)
// Note: require src/index.js will call run() if not guarded, so we'll
// extract testable functions into a separate require pattern

const { scanBundleDir, parseInfoFile } = require('../src/index.js');

describe('scanBundleDir', () => {
  const nativeDir = path.join(__dirname, 'fixtures/native-bundles');
  const desktopDir = path.join(__dirname, 'fixtures/desktop-bundle');

  it('finds android + ios bundles in native dir', () => {
    const bundles = scanBundleDir(nativeDir);
    assert.equal(bundles.length, 2);
    const platforms = bundles.map((b) => path.basename(b.zipPath)).sort();
    assert.deepEqual(platforms, ['android-bundle.zip', 'ios-bundle.zip']);
  });

  it('finds electron bundle in desktop dir', () => {
    const bundles = scanBundleDir(desktopDir);
    assert.equal(bundles.length, 1);
    assert.equal(path.basename(bundles[0].zipPath), 'electron-bundle.zip');
  });

  it('each bundle has matching infoPath', () => {
    const bundles = scanBundleDir(nativeDir);
    for (const b of bundles) {
      assert.ok(fs.existsSync(b.infoPath), `infoPath should exist: ${b.infoPath}`);
    }
  });

  it('throws on non-existent directory', () => {
    assert.throws(() => scanBundleDir('/tmp/does-not-exist-xyz'), /not found/i);
  });

  it('throws on directory with no bundles', () => {
    const emptyDir = path.join(__dirname, 'fixtures');
    assert.throws(() => scanBundleDir(emptyDir), /no bundle/i);
  });
});

describe('parseInfoFile', () => {
  const nativeDir = path.join(__dirname, 'fixtures/native-bundles');

  it('parses valid .info and returns metadata', () => {
    const infoPath = path.join(nativeDir, 'android-bundle.zip.info');
    const meta = parseInfoFile(infoPath);
    assert.equal(meta.appVersion, '6.1.0');
    assert.equal(meta.platform, 'android');
    assert.ok(meta.sha256);
  });

  it('maps appType to platform', () => {
    const infoPath = path.join(nativeDir, 'ios-bundle.zip.info');
    const meta = parseInfoFile(infoPath);
    assert.equal(meta.platform, 'ios');
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
cd qa-bundle-upload && node --test test/scan.test.js
```

Expected: FAIL — `scanBundleDir is not a function` (not exported yet).

**Step 3: Implement scanBundleDir and parseInfoFile in src/index.js**

Replace the full content of `qa-bundle-upload/src/index.js` with:

```javascript
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
const INFO_REQUIRED_FIELDS = ['appVersion', 'appType', 'sha256'];

// --- Directory scanning ---

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
    // Try {name}-bundle.zip.info first, then {name}-bundle.json.info
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
  try {
    raw = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
  } catch (e) {
    throw new Error(`${path.basename(infoPath)}: invalid JSON — ${e.message}`);
  }

  for (const field of INFO_REQUIRED_FIELDS) {
    if (!raw[field]) {
      throw new Error(`${path.basename(infoPath)}: missing required field "${field}"`);
    }
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
  };
}

// --- Crypto & upload (preserved from v1) ---

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
  form.append('commitHash', fields.commitHash);
  if (fields.branch) {
    form.append('branch', fields.branch);
  }
  if (fields.prTitle) {
    form.append('prTitle', fields.prTitle);
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

      const response = await axios.post(url, form, {
        headers: {
          ...form.getHeaders(),
          'X-Bundle-Timestamp': timestamp,
          'X-Bundle-Signature': signature,
        },
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

// --- Main ---

async function run() {
  try {
    // 1. Read inputs
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

    // 2. Scan directory
    core.info(`Scanning ${bundleDir} for bundles...`);
    const bundles = scanBundleDir(bundleDir);
    core.info(`Found ${bundles.length} bundle(s): ${bundles.map((b) => path.basename(b.zipPath)).join(', ')}`);

    // 3. Upload each bundle
    const uploadUrl = `${serverUrl}${UPLOAD_PATH}`;
    const results = [];
    let hasFailure = false;

    for (const bundle of bundles) {
      const meta = parseInfoFile(bundle.infoPath);
      const label = meta.platform;

      try {
        // Read and validate
        const fileBuffer = fs.readFileSync(bundle.zipPath);
        validateZipMagic(fileBuffer, label);

        const fileSizeMB = (fileBuffer.length / (1024 * 1024)).toFixed(2);
        core.info(`[${label}] Uploading ${path.basename(bundle.zipPath)} (${fileSizeMB} MB, v${meta.appVersion})...`);

        // SHA256 cross-check
        const computedHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
        if (computedHash !== meta.sha256) {
          throw new Error(`SHA256 mismatch: computed ${computedHash}, .info says ${meta.sha256}`);
        }
        core.info(`[${label}] SHA256: ${computedHash}`);

        // Upload
        const { data: result } = await uploadWithRetry({
          url: uploadUrl,
          fileBuffer,
          fileName: path.basename(bundle.zipPath),
          fields: { appVersion: meta.appVersion, platform: meta.platform, commitHash, branch, prTitle },
          fileHash: computedHash,
          secret,
          maxRetries,
          label,
        });

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

    // 4. Set outputs
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

// Allow testing by exporting functions, only call run() when executed directly
module.exports = { scanBundleDir, parseInfoFile, validateZipMagic };

if (require.main === module) {
  run();
}
```

**Step 4: Run tests to verify they pass**

```bash
cd qa-bundle-upload && node --test test/scan.test.js
```

Expected: all tests PASS.

**Step 5: Commit**

```bash
git add qa-bundle-upload/src/index.js qa-bundle-upload/test/scan.test.js
git commit -m "feat(qa-bundle-upload): implement scanBundleDir and parseInfoFile

Rewrite src/index.js for batch directory mode. Scans bundle-dir for
*-bundle.zip files, matches to .info metadata, validates fields,
and uploads each bundle serially with HMAC signing."
```

---

### Task 4: Build dist and verify

**Files:**
- Modify: `qa-bundle-upload/dist/index.js` (generated)

**Step 1: Install deps and build**

```bash
cd qa-bundle-upload/src && yarn && yarn build
```

**Step 2: Verify dist was generated**

```bash
ls -la qa-bundle-upload/dist/index.js
head -5 qa-bundle-upload/dist/index.js
```

Expected: `dist/index.js` exists and contains bundled code.

**Step 3: Verify the built file handles the `require.main` guard**

```bash
# Should exit cleanly without errors (no @actions/core in non-GHA env)
node -e "const m = require('./qa-bundle-upload/dist/index.js')" 2>&1 || echo "Expected: may warn about missing inputs but should not crash"
```

**Step 4: Commit**

```bash
git add qa-bundle-upload/dist/
git commit -m "build(qa-bundle-upload): rebuild dist for batch directory mode"
```

---

### Task 5: Manual verification with real artifacts

**Files:** None (read-only verification)

**Step 1: Verify scanBundleDir with real native artifacts**

```bash
node -e "
const { scanBundleDir, parseInfoFile } = require('./qa-bundle-upload/src/index.js');
const bundles = scanBundleDir('$HOME/Downloads/release-native-bundle-zips-6.1.0-2026030235-2-ab17696f0686ff4a8af78a33fa7958cbbe5d4f9e');
console.log('Found bundles:', bundles.length);
bundles.forEach(b => {
  const meta = parseInfoFile(b.infoPath);
  console.log(meta.platform, '-', meta.appVersion, '-', meta.sha256.slice(0, 12) + '...');
});
"
```

Expected output:
```
Found bundles: 2
android - 6.1.0 - cdb3c8b5ec87...
ios - 6.1.0 - d6e2805037...
```

**Step 2: Verify with real desktop artifacts**

```bash
node -e "
const { scanBundleDir, parseInfoFile } = require('./qa-bundle-upload/src/index.js');
const bundles = scanBundleDir('$HOME/Downloads/onekey-desktop-bundle-6.1.0-2026030235-2-ab17696f0686ff4a8af78a33fa7958cbbe5d4f9e');
console.log('Found bundles:', bundles.length);
bundles.forEach(b => {
  const meta = parseInfoFile(b.infoPath);
  console.log(meta.platform, '-', meta.appVersion, '-', meta.sha256.slice(0, 12) + '...');
});
"
```

Expected output:
```
Found bundles: 1
electron - 6.1.0 - e16f40efd7cb...
```

**Step 3: Verify SHA256 cross-check with real files**

```bash
node -e "
const fs = require('fs');
const crypto = require('crypto');
const { scanBundleDir, parseInfoFile } = require('./qa-bundle-upload/src/index.js');
const bundles = scanBundleDir('$HOME/Downloads/release-native-bundle-zips-6.1.0-2026030235-2-ab17696f0686ff4a8af78a33fa7958cbbe5d4f9e');
for (const b of bundles) {
  const meta = parseInfoFile(b.infoPath);
  const buf = fs.readFileSync(b.zipPath);
  const computed = crypto.createHash('sha256').update(buf).digest('hex');
  const match = computed === meta.sha256 ? 'MATCH' : 'MISMATCH';
  console.log(meta.platform, match, computed.slice(0, 16));
}
"
```

Expected: both show `MATCH`.

---

### Task 6: Add test script to package.json

**Files:**
- Modify: `qa-bundle-upload/package.json`

**Step 1: Add test script**

Add `"test": "node --test test/"` to the scripts section of `qa-bundle-upload/package.json`:

```json
{
  "scripts": {
    "build": "ncc build src/index.js -m -o ./dist/",
    "test": "node --test test/"
  }
}
```

**Step 2: Run tests via npm script**

```bash
cd qa-bundle-upload && yarn test
```

Expected: all tests PASS.

**Step 3: Commit**

```bash
git add qa-bundle-upload/package.json
git commit -m "chore(qa-bundle-upload): add test script to package.json"
```

---

### Task 7: Update .gitignore for test fixtures

**Files:**
- Check: `.gitignore`

**Step 1: Verify test fixtures aren't gitignored**

```bash
git status qa-bundle-upload/test/
```

If test fixtures show up as untracked, they should be committed (they're tiny). If `.gitignore` blocks them, adjust accordingly. The fixture ZIP files are ~100 bytes each, not real 57MB bundles.

**Step 2: Commit if needed**

```bash
git add qa-bundle-upload/test/
git commit -m "test(qa-bundle-upload): ensure test fixtures are tracked"
```
