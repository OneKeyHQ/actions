const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { uploadWithRetry, isRetryableError, getRetryDelayMs, ServerResponseError } = require('../src/index.js');

const OK_BODY = { code: 0, message: 'success', data: { bundleVersion: 42, downloadUrl: 'https://example.com/ios.zip' } };

function reply(res, { status, body, headers = {} }) {
  const isText = typeof body === 'string';
  res.writeHead(status, { 'content-type': isText ? 'text/plain' : 'application/json', ...headers });
  res.end(isText ? body : JSON.stringify(body));
}

// Serves scripted responses in order; the last one repeats. A response with
// `early: true` is sent without reading the request body, like a gateway that
// gives up on a stalled upload.
async function withServer(responses, fn) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const next = responses[Math.min(requests.length, responses.length - 1)];
    const record = { headers: req.headers, bytes: 0 };
    requests.push(record);
    if (next.early) {
      req.pause();
      reply(res, { ...next, headers: { connection: 'close', ...next.headers } });
      return;
    }
    req.on('data', (chunk) => {
      record.bytes += chunk.length;
    });
    req.on('end', () => reply(res, next));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}/upload`, requests);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

function upload(url, { maxRetries = 5, size = 256 * 1024 } = {}) {
  return uploadWithRetry({
    url,
    fileBuffer: Buffer.alloc(size, 1),
    fileName: 'ios-bundle.zip',
    fields: { appVersion: '6.6.0', platform: 'ios' },
    fileHash: 'a'.repeat(64),
    secret: 'test-secret',
    maxRetries,
    label: 'test',
    baseDelayMs: 1,
  });
}

describe('uploadWithRetry', () => {
  it('retries gateway 408 and 502 until the upload succeeds', async () => {
    await withServer(
      [
        { status: 408, body: 'request timeout' },
        { status: 502, body: '' },
        { status: 200, body: OK_BODY },
      ],
      async (url, requests) => {
        assert.deepEqual(await upload(url), OK_BODY);
        assert.equal(requests.length, 3);
        for (const req of requests) {
          assert.ok(req.headers['x-bundle-timestamp']);
          assert.ok(req.headers['x-bundle-signature']);
          assert.ok(req.bytes > 256 * 1024, 'full multipart body should be sent');
        }
      }
    );
  });

  it('retries when the gateway answers 408 before reading the body', async () => {
    await withServer(
      [
        { status: 408, body: 'request timeout', early: true },
        { status: 200, body: OK_BODY },
      ],
      async (url, requests) => {
        assert.deepEqual(await upload(url, { size: 8 * 1024 * 1024 }), OK_BODY);
        assert.equal(requests.length, 2);
      }
    );
  });

  it('retries the server uncaught-error code 40000', async () => {
    await withServer(
      [
        { status: 200, body: { code: 40000, message: 'Something went wrong. Try again.', data: null } },
        { status: 200, body: OK_BODY },
      ],
      async (url, requests) => {
        assert.deepEqual(await upload(url), OK_BODY);
        assert.equal(requests.length, 2);
      }
    );
  });

  it('does not retry a non-retryable server code', async () => {
    await withServer([{ status: 200, body: { code: 409, message: 'conflict', data: null } }], async (url, requests) => {
      await assert.rejects(upload(url), /non-retryable error: Server returned error: .*"code":409/);
      assert.equal(requests.length, 1);
    });
  });

  it('does not retry other HTTP 4xx', async () => {
    await withServer([{ status: 400, body: 'bad request' }], async (url, requests) => {
      await assert.rejects(upload(url), /non-retryable error: HTTP 400, body=bad request/);
      assert.equal(requests.length, 1);
    });
  });

  it('logs HTML error pages on a single line', async () => {
    const page = '<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body></body>\r\n</html>';
    await withServer([{ status: 502, body: page }], async (url) => {
      await assert.rejects(
        upload(url, { maxRetries: 1 }),
        /HTTP 502, body=<html> <head><title>502 Bad Gateway<\/title><\/head> <body><\/body> <\/html> \(after/
      );
    });
  });

  it('rejects an invalid max-retries instead of looping', async () => {
    await assert.rejects(upload('http://127.0.0.1:9/upload', { maxRetries: Number.NaN }), /Invalid max-retries: NaN/);
  });

  it('gives up after max-retries and reports the last failure with trace headers', async () => {
    await withServer(
      [{ status: 502, body: '', headers: { 'cf-ray': 'abc123-SJC', server: 'cloudflare' } }],
      async (url, requests) => {
        await assert.rejects(
          upload(url, { maxRetries: 3 }),
          /all 3 attempts failed, last error: HTTP 502, cf-ray=abc123-SJC, server=cloudflare \(after [\d.]+s\)$/
        );
        assert.equal(requests.length, 3);
      }
    );
  });
});

describe('isRetryableError', () => {
  const httpError = (status) => Object.assign(new Error(`status ${status}`), { response: { status } });

  it('retries network errors, 408 and 5xx', () => {
    assert.equal(isRetryableError(Object.assign(new Error('reset'), { code: 'ECONNRESET' })), true);
    for (const status of [408, 500, 502, 503, 504, 520, 522]) {
      assert.equal(isRetryableError(httpError(status)), true, `HTTP ${status}`);
    }
  });

  it('does not retry other 4xx', () => {
    for (const status of [400, 401, 403, 404, 409, 413, 429]) {
      assert.equal(isRetryableError(httpError(status)), false, `HTTP ${status}`);
    }
  });

  it('retries only the uncaught-error body code', () => {
    assert.equal(isRetryableError(new ServerResponseError({ code: 40000 })), true);
    for (const body of [{ code: 401 }, { code: 409 }, { code: 429 }, { code: 500 }, '<html>', null]) {
      assert.equal(isRetryableError(new ServerResponseError(body)), false, JSON.stringify(body));
    }
  });
});

describe('getRetryDelayMs', () => {
  it('backs off exponentially with jitter and a 30s cap', () => {
    for (let i = 0; i < 50; i++) {
      const first = getRetryDelayMs(1);
      assert.ok(first >= 1000 && first <= 2000, `attempt 1: ${first}`);
      const fourth = getRetryDelayMs(4);
      assert.ok(fourth >= 8000 && fourth <= 16000, `attempt 4: ${fourth}`);
      const late = getRetryDelayMs(10);
      assert.ok(late >= 15000 && late <= 30000, `attempt 10: ${late}`);
    }
  });
});
