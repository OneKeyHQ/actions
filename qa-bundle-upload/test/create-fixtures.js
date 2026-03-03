const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Minimal valid ZIP: local file header + central directory + end record
const ZIP_HEADER = Buffer.from([
  0x50, 0x4b, 0x03, 0x04, // local file header signature
  0x14, 0x00, 0x00, 0x00, 0x08, 0x00,
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
  0x02, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x00, 0x00,
  0x78,
  0x03, 0x00,
  0x50, 0x4b, 0x01, 0x02,
  0x14, 0x00, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00,
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
  0x02, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
  0x78,
  0x50, 0x4b, 0x05, 0x06,
  0x00, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x01, 0x00,
  0x2f, 0x00, 0x00, 0x00,
  0x25, 0x00, 0x00, 0x00,
  0x00, 0x00,
]);

function createBundle(dir, name, platform) {
  const zipPath = path.join(dir, `${name}-bundle.zip`);
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

fs.mkdirSync(nativeDir, { recursive: true });
fs.mkdirSync(desktopDir, { recursive: true });

createBundle(nativeDir, 'android', 'android');
createBundle(nativeDir, 'ios', 'ios');
createBundle(desktopDir, 'electron', 'electron');

console.log('\nFixtures created successfully.');
