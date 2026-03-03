# QA Bundle Upload Action

Scan a directory for `*-bundle.zip` + `.info` metadata files, then upload each bundle to the Utility server via HMAC-signed multipart POST.

## Quick Start

```yaml
- name: Upload QA Bundles
  id: upload
  uses: ./qa-bundle-upload
  with:
    server-url: ${{ secrets.UTILITY_SERVER_URL }}
    upload-secret: ${{ secrets.JS_BUNDLE_UPLOAD_SECRET }}
    bundle-dir: ./dist/bundles
    commit-hash: ${{ github.sha }}
    branch: ${{ github.ref_name }}
    pr-title: ${{ github.event.pull_request.title }}

- name: Print upload results
  run: echo '${{ steps.upload.outputs.results }}' | jq '.'
```

## Inputs

| Name | Required | Default | Description |
|------|----------|---------|-------------|
| `server-url` | Yes | — | Utility server URL, e.g. `https://utility.onekey.so` |
| `upload-secret` | Yes | — | HMAC-SHA256 signing secret (`JS_BUNDLE_UPLOAD_SECRET`) |
| `bundle-dir` | Yes | — | Directory containing `*-bundle.zip` and `.info` files |
| `commit-hash` | No | `${{ github.sha }}` | Git commit hash |
| `branch` | No | — | Git branch name |
| `pr-title` | No | — | Pull request title |
| `max-retries` | No | `3` | Maximum retry attempts (including first try) |

## Outputs

| Name | Description |
|------|-------------|
| `results` | JSON array of upload results |

```json
[
  {
    "platform": "android",
    "bundleVersion": "42",
    "downloadUrl": "https://utility.onekey.so/download/android-v42",
    "sha256": "506d55db...",
    "fileSize": "5242880"
  }
]
```

> Even if some bundles fail, the `results` output still contains the successfully uploaded ones.

## Bundle Directory Structure

The action scans `bundle-dir` for ZIP files matching `*-bundle.zip` and pairs each with a `.info` metadata file.

```
dist/bundles/
├── android-bundle.zip          ← ZIP file
├── android-bundle.zip.info     ← metadata (native convention)
├── ios-bundle.zip
├── ios-bundle.zip.info
├── electron-bundle.zip
└── electron-bundle.json.info   ← metadata (electron convention)
```

### Naming Convention

For a ZIP named `{prefix}-bundle.zip`, the action looks for `.info` files in this priority order:

1. `{prefix}-bundle.zip.info` (used by native platforms)
2. `{prefix}-bundle.json.info` (used by electron)

### `.info` File Format

Each `.info` file is a JSON object with the following fields:

```json
{
  "fileName": "android-bundle.zip",
  "appVersion": "6.1.0",
  "appType": "android",
  "sha256": "506d55db48f8140ef0e9e6217fdce6147e59f6a3ebfd85d7251af9be1c31fc08",
  "size": 5242880,
  "buildNumber": "2026030235",
  "bundleVersion": "2"
}
```

**Required fields:**

| Field | Validation | Example |
|-------|-----------|---------|
| `fileName` | Non-empty string | `"android-bundle.zip"` |
| `appVersion` | Semver format `x.y.z` | `"6.1.0"` |
| `appType` | `android` \| `ios` \| `electron` | `"android"` |
| `sha256` | 64 hex characters (case-insensitive) | `"506d55db..."` |

Optional fields: `size`, `buildNumber`, `bundleVersion`, `generatedAt`.

### ZIP Validation

- The file must start with ZIP magic bytes (`PK\x03\x04`).
- The computed SHA256 of the ZIP file must match the `sha256` value in the `.info` file (comparison is case-insensitive).

## Upload Protocol

The action uploads each bundle via `POST /v1/app-update/bundles/upload` with HMAC authentication.

### HMAC Signature

```
timestamp = floor(Date.now() / 1000)
signature = HMAC-SHA256("${timestamp}:${sha256_of_zip}", secret).hex()
```

### HTTP Request

```http
POST /v1/app-update/bundles/upload HTTP/1.1
Host: {server-url}
X-Bundle-Timestamp: {timestamp}
X-Bundle-Signature: {signature}
Content-Type: multipart/form-data

file:        (binary ZIP)
appVersion:  "6.1.0"
platform:    "android"
commitHash:  "abc123..."
branch:      "feat/update"
prTitle:     "Add new features"
```

### Expected Server Response

The server must return JSON containing at least:

```json
{
  "bundleVersion": "42",
  "downloadUrl": "https://..."
}
```

### Retry Behavior

| Condition | Retries? |
|-----------|----------|
| Network error | Yes |
| 5xx server error | Yes |
| 4xx client error | No |
| Timeout (5 min) | Yes |

Retry delay uses exponential backoff: 2s → 4s → 8s …

## Error Handling

The action fails (`core.setFailed`) if:

- `bundle-dir` does not exist or is not a directory
- No `*-bundle.zip` files found in the directory
- Any ZIP is missing its corresponding `.info` file
- Any bundle fails to upload after all retries

A single bundle's `.info` parse failure or SHA256 mismatch will skip that bundle and continue processing the rest — the action still fails at the end if any bundle was skipped.

## Server Integration Checklist

If you're implementing the server-side endpoint:

- [ ] Accept `POST /v1/app-update/bundles/upload` with `multipart/form-data`
- [ ] Validate HMAC signature: `HMAC-SHA256("${X-Bundle-Timestamp}:${sha256_of_uploaded_file}", secret)`
- [ ] Accept form fields: `file`, `appVersion`, `platform`, `commitHash` (optional), `branch` (optional), `prTitle` (optional)
- [ ] Return JSON with `bundleVersion` and `downloadUrl` on success
- [ ] Return 4xx for client errors (bad request, validation failure)
- [ ] Return 5xx for retriable server errors
