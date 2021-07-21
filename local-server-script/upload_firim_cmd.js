var exec = require("child_process").exec;

exports.upload = function (token, file, changelog) {
    if (changelog) {
        changelog = changelog.replace(/:-:/g, '\n')
    }
    return new Promise(function (resolve, reject) {
        var cmd = "fir p " + file + " -R -c '" + changelog + "' --no-qrcode -T " + token;
        exec(cmd, {
            maxBuffer: 1024 * 2000
        }, function (err, stdout, stderr) {
            if (err) {
                console.error(err);
                reject(err);
            } else if (stderr.lenght > 0) {
                console.error('No output from console');
                reject(new Error(stderr.toString()));
            } else {
                try {
                    let reg = new RegExp("Published succeed: (https?):\/\/[-A-Za-z0-9+&@#/%?=~_|!:,.;]+[-A-Za-z0-9+&@#/%=~_|]");
                    let download_url = stdout.match(reg)[0].replace('Published succeed: ', '');
                    if (download_url && download_url.length > 0) {
                        console.log(download_url);
                        resolve(download_url);
                    } else {
                        reject(new Error('Upload failed!'));
                    }
                } catch (error) {
                    console.error(error);
                    reject(error);
                }

            }
        });
    });
};