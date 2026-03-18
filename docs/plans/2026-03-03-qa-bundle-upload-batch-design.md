# QA Bundle Upload — Batch Directory Mode Design

> Extend qa-bundle-upload action to accept a directory containing multiple bundle ZIPs + .info metadata files, automatically scanning, reading metadata, and uploading each bundle serially.

## TL;DR

Replace single-file mode with directory mode: action receives `bundle-dir` path → scans for `*-bundle.zip` + `.info` → reads `appVersion`/`platform` from `.info` → uploads each bundle to Utility server via HMAC-signed multipart POST.

## Context

- CI workflows (`release-native-bundle.yml`, `release-desktop-bundle.yml`) build bundles and stage them in a directory before uploading as GitHub artifacts
- Native workflow produces `android-bundle.zip` + `ios-bundle.zip` in `./apps/mobile/out-dir-bundle-zip/`
- Desktop workflow produces `electron-bundle.zip` in `./apps/desktop/bundle-zip/`
- Each bundle ZIP has a corresponding `.info` file with metadata (appVersion, appType, sha256, size, etc.)
- The action runs as a step in the same job — files are already on disk, no ZIP extraction needed

## Decision: Drop Single-File Mode

Single-file mode (`file-path` + manual `app-version` + `platform`) is removed. Directory mode is the only mode. Rationale: all callers are CI workflows with bundles in a directory alongside `.info` files. A single mode keeps the action simple.

---

## Inputs

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `server-url` | yes | — | Utility server URL, e.g. `https://utility.onekey.so` |
| `upload-secret` | yes | — | HMAC-SHA256 signing secret |
| `bundle-dir` | yes | — | Directory containing `*-bundle.zip` and `.info` files |
| `commit-hash` | no | `${{ github.sha }}` | Git commit hash |
| `branch` | no | — | Git branch name |
| `pr-title` | no | — | PR title |
| `max-retries` | no | `3` | Maximum retry attempts (including first try) |

**Removed inputs:** `file-path`, `app-version`, `platform` (all read from `.info` files)

## Outputs

| Parameter | Description |
|-----------|-------------|
| `results` | JSON array — each element: `{ platform, bundleVersion, downloadUrl, sha256, fileSize }` |

## Usage

```yaml
# Native workflow — uploads android + ios
- name: Upload bundles to QA
  uses: onekeyhq/actions/qa-bundle-upload@main
  with:
    server-url: 'https://utility.onekey.so'
    upload-secret: ${{ secrets.JS_BUNDLE_UPLOAD_SECRET }}
    bundle-dir: './apps/mobile/out-dir-bundle-zip'
    commit-hash: ${{ github.sha }}
    branch: ${{ github.ref_name }}
    pr-title: ${{ github.event.pull_request.title }}

# Desktop workflow — uploads electron
- name: Upload bundle to QA
  uses: onekeyhq/actions/qa-bundle-upload@main
  with:
    server-url: 'https://utility.onekey.so'
    upload-secret: ${{ secrets.JS_BUNDLE_UPLOAD_SECRET }}
    bundle-dir: './apps/desktop/bundle-zip'
    commit-hash: ${{ github.sha }}
    branch: ${{ github.ref_name }}
```

---

## Core Flow

```
1. Read inputs (server-url, upload-secret, bundle-dir, ...)
2. Scan bundle-dir:
   a. Find all *-bundle.zip files
   b. For each bundle ZIP, find matching .info file
      - {name}-bundle.zip → {name}-bundle.zip.info OR {name}-bundle.json.info
   c. No bundle ZIPs found → core.setFailed
   d. Bundle ZIP without matching .info → core.setFailed
3. For each bundle (serial):
   a. Parse .info JSON → extract appVersion, appType (platform), sha256
   b. Read bundle ZIP into Buffer
   c. Validate ZIP magic bytes (PK\x03\x04)
   d. Compute SHA256, cross-check with .info sha256
   e. Generate HMAC signature (timestamp + sha256)
   f. Build multipart/form-data
   g. POST upload with retry
   h. Record result
4. Aggregate results, set outputs
5. Any bundle upload failed → core.setFailed
```

### .info File Matching

Real artifact structures:
- `android-bundle.zip` → `android-bundle.zip.info`
- `ios-bundle.zip` → `ios-bundle.zip.info`
- `electron-bundle.zip` → `electron-bundle.json.info`

Strategy: for `{name}-bundle.zip`, look for `{name}-bundle.zip.info` first, fall back to `{name}-bundle.json.info`.

### .info File Schema

```json
{
  "fileName": "android-bundle.zip",
  "sha256": "cdb3c8b5...",
  "size": 57235048,
  "generatedAt": "2026-03-02T20:34:58.267Z",
  "appType": "android",
  "appVersion": "6.1.0",
  "buildNumber": "2026030235",
  "bundleVersion": "2"
}
```

Required fields for upload: `appVersion`, `appType` (mapped to `platform`), `sha256`.

### SHA256 Cross-Check

The `.info` file contains a pre-computed SHA256. The action also computes SHA256 from the actual file. Both must match — mismatch indicates file corruption or tampering.

### Serial Upload

Bundles are uploaded one at a time. Rationale:
- Files are ~57MB each; parallel upload won't be faster (network bandwidth bottleneck)
- Serial execution produces clearer logs
- Easier to debug failures

---

## Error Handling

| Scenario | Action |
|----------|--------|
| `bundle-dir` doesn't exist or isn't a directory | `core.setFailed('bundle-dir not found or not a directory')` |
| No `*-bundle.zip` found | `core.setFailed('No bundle ZIP files found in {dir}')` |
| Bundle ZIP has no matching `.info` | `core.setFailed('{name}: no matching .info file')` |
| `.info` JSON parse error | `core.setFailed('{name}.info: invalid JSON')` |
| `.info` missing required field | `core.setFailed('{name}.info: missing required field {field}')` |
| SHA256 mismatch (computed vs .info) | `core.setFailed('{name}: SHA256 mismatch')` |
| ZIP magic bytes check failed | `core.setFailed('{name}: not a valid ZIP')` |
| Server 4xx | No retry, `core.setFailed` |
| Server 5xx / network error | Exponential backoff retry, exhaust → `core.setFailed` |
| Partial success (some bundles uploaded, some failed) | Successful results recorded in output, overall `core.setFailed` |

### Log Format

```
[android] Uploading android-bundle.zip (57.23 MB, v6.1.0)...
[android] SHA256: cdb3c8b5...
[android] Upload attempt 1/3...
[android] Upload successful! Bundle version: 3
[android] Download URL: https://...

[ios] Uploading ios-bundle.zip (57.23 MB, v6.1.0)...
...
```

---

## File Structure

```
qa-bundle-upload/
├── action.yml          # Updated inputs/outputs
├── package.json        # No dependency changes
├── src/
│   └── index.js        # Rewritten for directory mode
├── dist/
│   └── index.js        # ncc build output
└── yarn.lock
```

Single file `src/index.js` — logic increase is modest:
- New: `scanBundleDir()` — scan directory, match .info files
- New: `parseInfoFile()` — parse .info JSON, validate fields
- Existing: `computeSignature()`, `buildFormData()`, `uploadWithRetry()` — minimal changes
- `run()` — rewritten to loop over discovered bundles

### Dependencies

No new dependencies. `fs.readdirSync` + `path` handle directory scanning.

---

## Workflow Integration

Add the qa-bundle-upload step **before** the existing `upload-artifact` step in both workflows:

```yaml
# release-native-bundle.yml
- name: Upload bundles to QA
  uses: onekeyhq/actions/qa-bundle-upload@main
  with:
    server-url: 'https://utility.onekey.so'
    upload-secret: ${{ secrets.JS_BUNDLE_UPLOAD_SECRET }}
    bundle-dir: './apps/mobile/out-dir-bundle-zip'
    commit-hash: ${{ github.sha }}
    branch: ${{ github.ref_name }}

- name: upload zips
  uses: actions/upload-artifact@v4
  ...
```

## Implementation Notes

- Runtime: `node20`
- The action no longer supports single-file mode — this is a breaking change
- `.info` field `appType` maps directly to the `platform` form field in the upload request
- `metadata.json` files in the desktop bundle are ignored (not a bundle, not uploaded)
