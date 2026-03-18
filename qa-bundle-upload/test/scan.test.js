const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { scanBundleDir, parseInfoFile, validateZipMagic } = require('../src/index.js');

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
    assert.equal(buf[0], 0x50);
    assert.equal(buf[1], 0x4b);
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

describe('scanBundleDir', () => {
  const nativeDir = path.join(__dirname, 'fixtures/native-bundles');
  const desktopDir = path.join(__dirname, 'fixtures/desktop-bundle');

  it('finds android + ios bundles in native dir', () => {
    const bundles = scanBundleDir(nativeDir);
    assert.equal(bundles.length, 2);
    const names = bundles.map((b) => path.basename(b.zipPath)).sort();
    assert.deepEqual(names, ['android-bundle.zip', 'ios-bundle.zip']);
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
  const desktopDir = path.join(__dirname, 'fixtures/desktop-bundle');

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

  it('handles electron .json.info format', () => {
    const infoPath = path.join(desktopDir, 'electron-bundle.json.info');
    const meta = parseInfoFile(infoPath);
    assert.equal(meta.platform, 'electron');
    assert.equal(meta.appVersion, '6.1.0');
  });
});

describe('validateZipMagic', () => {
  it('accepts valid ZIP buffer', () => {
    const buf = fs.readFileSync(path.join(__dirname, 'fixtures/native-bundles/android-bundle.zip'));
    assert.doesNotThrow(() => validateZipMagic(buf, 'android'));
  });

  it('rejects non-ZIP buffer', () => {
    const buf = Buffer.from('not a zip file');
    assert.throws(() => validateZipMagic(buf, 'test'), /not a valid ZIP/);
  });
});
