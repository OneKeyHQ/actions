const core = require('@actions/core');
const needle = require('needle');
const path = require('path')
const fs = require('fs')
const fsPromises = fs.promises;
const Client = require('ssh2-sftp-client');
const sftp = new Client();


async function main() {

    const host = core.getInput('host')
    const port = core.getInput('port') || 22;
    const username = core.getInput('username')
    const password = core.getInput('password')

    const file_path_name = core.getInput('file_path_name') || 'version_regtest.json'
    const remote_path_dir = core.getInput('remote_path_dir') || '/output'
    const release_type = core.getInput('release_type') || 'website'

    let local_file_path = path.join('./', file_path_name)
    let remotePath = path.join(remote_path_dir, file_path_name)

    let version_code = core.getInput('version_code')
    let version_name = core.getInput('version_name')
    let changelog_en = core.getInput('changelog_en') || 'This update contains several bug fixes and performance enhancements.'
    let changelog_cn = core.getInput('changelog_cn') || '此更新包含一些错误修复和性能提升。'
    let force_versionCode = core.getInput('force_versionCode')
    let sha256sum_asc_url = core.getInput('sha256sum_asc_url')
    let download_url = core.getInput('download_url')

    try {
        let file_path = await sftp.connect({
            host: host,
            port: port,
            username: username,
            password: password
        }).then(() => {
            return sftp.get(remotePath, local_file_path);
        })

        let filehandle = null;

        filehandle = await fsPromises.open(file_path, 'r+');
        data = await filehandle.readFile();
        if (filehandle) filehandle.close();

        update_conf = JSON.parse(data)

        if (release_type == 'website') {
            if (version_code) update_conf['APK']['versionCode'] = version_code
            if (version_name) update_conf['APK']['versionName'] = version_name
            if (changelog_en) update_conf['APK']['changelog_en'] = changelog_en
            if (changelog_cn) update_conf['APK']['changelog_cn'] = changelog_cn
            if (force_versionCode) update_conf['APK']['force_versionCode'] = force_versionCode

            app_path = download_url.replace("onekey.243096.com", "onekey-asset.com")
            if (app_path) update_conf['APK']['url'] = app_path

            let file_size = undefined
            try {
                file_size = await needle('head', app_path)
                    .then((result) => {
                        return JSON.parse(JSON.stringify(result.headers))['content-length']
                    })
            } catch (error) {
                console.error(error)
            }
            if (file_size) update_conf['APK']['size'] = parseInt(file_size / 1024.0 / 1024) + 'M'

            if (sha256sum_asc_url) update_conf['APK']['sha256sum_asc'] = sha256sum_asc_url
        } else {
            if (!update_conf['APK']['googlePlay']) update_conf['APK']['googlePlay'] = {}
            if (version_code) update_conf['APK']['googlePlay']['versionCode'] = version_code
            if (version_name) update_conf['APK']['googlePlay']['versionName'] = version_name
            if (changelog_en) update_conf['APK']['googlePlay']['changelog_en'] = changelog_en
            if (changelog_cn) update_conf['APK']['googlePlay']['changelog_cn'] = changelog_cn
            if (force_versionCode) update_conf['APK']['googlePlay']['force_versionCode'] = force_versionCode
        }

        var formattedStr = JSON.stringify(update_conf, null, 4);
        console.debug(formattedStr)

        filehandle = await fsPromises.open(file_path, 'w');
        data = await filehandle.writeFile(formattedStr);
        if (filehandle) filehandle.close();

        await sftp.put(local_file_path, remotePath);
    } catch (e) {
        console.error(e)
    } finally {
        return sftp.end();
    }

}

main().catch(err => core.setFailed(err.message));
