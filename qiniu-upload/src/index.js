const core = require('@actions/core');
const qiniu = require('qiniu');
const upload = require('./upload');

function generatePutPolicyToken(bucket, ak, sk) {
    const mac = new qiniu.auth.digest.Mac(ak, sk);

    const putPolicy = new qiniu.rs.PutPolicy({
        scope: bucket,
    });
    return putPolicy.uploadToken(mac);
}

async function main() {
    const ak = core.getInput('access_key');
    const sk = core.getInput('secret_key');
    const bucket = core.getInput('bucket');
    const sourceDir = core.getInput('source_dir');
    const targetDir = core.getInput('dest_dir');

    const token = generatePutPolicyToken(bucket, ak, sk);
    const config = new qiniu.conf.Config({
        useCdnDomain: true,
        useHttpsDomain: true,
    });
    const uploader = new qiniu.form_up.FormUploader(config);

    await upload(
        uploader,
        token,
        sourceDir,
        targetDir,
    );

    console.log('====== all file uploaded! =====');
}

main().catch(err => core.setFailed(err.message));
