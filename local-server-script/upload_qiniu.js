const path = require('path');
const fs = require('fs');

const qiniu = require('qiniu');
const glob = require('glob');
const retry = require('p-retry');

exports.generateToken = function (bucket, ak, sk) {
    const mac = new qiniu.auth.digest.Mac(ak, sk);

    const putPolicy = new qiniu.rs.PutPolicy({
        scope: bucket,
    });
    return putPolicy.uploadToken(mac);
}

exports.upload = function (
    uploader,
    token,
    srcDir,
    targetDir,
) {
    const baseDir = path.resolve(process.cwd(), srcDir);
    let files = glob.sync(`${baseDir}/**/*`, { nodir: true });

    return Promise.resolve(files)
        .map((pathToFile) => {
            const relativePath = path.relative(baseDir, path.dirname(pathToFile));
            const key = path.join(targetDir, relativePath, path.basename(pathToFile));

            const promise = new Promise((resolve, reject) => {
                const putExtra = new qiniu.form_up.PutExtra();
                const reader = fs.createReadStream(pathToFile);

                uploader.putStream(token, key, reader, putExtra, (err, body, info) => {
                    if (err) {
                        console.log(err);
                        return reject(new Error(`Upload failed: ${pathToFile}`));
                    }

                    if (info.statusCode === 200) {
                        console.log(`Upload success: ${body.key}`);
                        return resolve({ file: pathToFile, to: key });
                    }

                    reject(new Error(`Upload failed: ${pathToFile} - ${info.statusMessage}`));
                });
            });
            return retry(() => promise, { timeout: 100000, interval: 10000, backoff: 2 });
        }, { concurrency: 1 });
}

exports.upload_file = function (
    uploader,
    token,
    file_path,
    targetDir,
) {
    const key = path.join(targetDir, path.basename(file_path));

    const promise = new Promise((resolve, reject) => {
        const putExtra = new qiniu.form_up.PutExtra();
        const reader = fs.createReadStream(file_path);

        uploader.putStream(token, key, reader, putExtra, (err, body, info) => {
            if (err) {
                console.log(err);
                return reject(new Error(`Upload failed: ${file_path}`));
            }

            if (info.statusCode === 200) {
                console.log(`Upload success: ${body.key}`);
                return resolve({ file: file_path, to: key });
            }

            reject(new Error(`Upload failed: ${file_path} - ${info.statusMessage}`));
        });
    });
    return retry(() => promise, { timeout: 100000, interval: 10000, backoff: 2 });
}
