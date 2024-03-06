const core = require('@actions/core');
const axios = require('axios');
const crypto = require('crypto');

async function run() {
  try {
    const webhookUrl = core.getInput('web-hook-url');
    const secretKey = core.getInput('secret-key');
    const data = {
      platform: core.getInput('artifact-type'),
      artifactName: core.getInput('artifact-name'),
      bundleId: core.getInput('artifact-bundle-id'),
      versionName: core.getInput('artifact-version-name'),
      buildNumber: core.getInput('artifact-version-code'),
      downloadUrl: core.getInput('artifact-download-url'),
    };

    const dataString = JSON.stringify(data);
    const hash = crypto.createHmac('sha1', secretKey)
    .update(dataString)
    .digest('hex');

    const headers = {
      'github-action-signature': `sha1=${hash}`
    };

    await axios.post(webhookUrl, data, { headers });

    console.log('Notification sent successfully');
  } catch (error) {
    core.setFailed(`Action failed with error ${error}`);
  }
}

run();
