const path = require('path');
const fs = require('fs');

const qiniu = require('qiniu');
const glob = require('glob');
const Promise = require('bluebird');
const retry = require('bluebird-retry');

module.exports = function (
    uploader,
    token,
    srcDir,
    targetDir,
) {
    const baseDir = path.resolve(process.cwd(), srcDir);
    let files = undefined

    let src = fs.lstatSync(srcDir);

    if (src.isFile()) {
        files = [srcDir]
    } else {
        files = glob.sync(`${baseDir}/**/*`, { nodir: true });
    }

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
