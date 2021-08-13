const path = require('path')
const fs = require('fs')
const fsPromises = fs.promises;

const upload_firim = require('./upload_firim_cmd');
const upload_notice = require('./upload_notice_slack');
const artifact_parser = require('./artifact_parser');

const qiniu = require('qiniu');
const qiniu_upload = require('./upload_qiniu');

const argv = require('minimist')(process.argv.slice(2));


const base_dir = "/output"
const base_apk_dir = "/output/apk"


async function fun_upload_firim() {
    let firim_api_token = argv['firim_token']
    let changelog_cn = argv['changelog']
    let web_hook_url = argv['web_hook_url']
    let version_suffix = argv['version_suffix']
    let file_name = argv['filename']

    let custom_message_title = argv['custom_message_title']
    let custom_message_payload = argv['custom_message_payload']
    let custom_issue_url = argv['custom_issue_url']
    let notice_slack = argv['notice_slack'] || true

    let apk_file_path = path.join(base_apk_dir, file_name)

    let artifact_info = await artifact_parser.parser(apk_file_path)
    artifact_info.changelog = changelog_cn

    if (artifact_info.platform == 'ios') {
        artifact_info.release_type = "Adhoc"
    }
    if (version_suffix) {
        artifact_info.versionName += "-" + version_suffix
    }

    console.log("begin upload firim.")
    let upload_info = await upload_firim.upload(firim_api_token, apk_file_path, artifact_info.changelog)
        .then((download_url) => {
            artifact_info.download_url = download_url
        })
    if (notice_slack == true || notice_slack == 'true') {
        console.log("Notify the slack.")
        await upload_notice.notice(web_hook_url, artifact_info, {
            "title": custom_message_title,
            "payload": custom_message_payload,
            "issue_url": custom_issue_url,
        })
    }
}

async function upload_qiniu() {
    let file_name = argv['filename']

    let apk_file_path = path.join(base_apk_dir, file_name)

    let access_key = argv['access_key']
    let secret_key = argv['secret_key']
    let bucket = argv['bucket']

    let qiniu_token = qiniu_upload.generateToken(bucket, access_key, secret_key);
    let config = new qiniu.conf.Config({
        useCdnDomain: true,
        useHttpsDomain: true,
    });
    let uploader = new qiniu.form_up.FormUploader(config);

    let artifact_info = await artifact_parser.parser(apk_file_path)
    if (!artifact_info && !artifact_info.platform) {
        throw new Error("Artifact 解析错误")
    }

    let targetDir = "onekey/" + artifact_info.platform + "/v" + artifact_info.versionName

    let upload_result = await qiniu_upload.upload_file(
        uploader,
        qiniu_token,
        apk_file_path,
        targetDir,
    );

    let download_url = "https://onekey-asset.com/" + upload_result.to
    console.log(download_url)
    return download_url
}

function notIsStrEmpty(str) {
    if (str && typeof (str) === 'string' && str.trim() !== '') {
        return true
    }
    return false
}

async function update_version_json(qiniu_download_url) {
    let changelog_cn = argv['changelog'] || 'This update contains several bug fixes and performance enhancements.'
    let changelog_en = argv['changelog_en'] || '此更新包含一些错误修复和性能提升。'
    let file_name = argv['filename']
    let file_path_name = argv['jsonfilename'] || 'version_regtest.json'
    let release_type = argv['release_type'] || "website"
    let force_versionCode = argv['force_versionCode']
    let download_url = argv['download_url'] || qiniu_download_url
    let sha256sum_asc_url = argv['sha256sum_asc_url']

    let local_file_path = path.join(base_dir, file_path_name)

    let apk_file_path = path.join(base_apk_dir, file_name)
    let artifact_info = await artifact_parser.parser(apk_file_path)

    if (artifact_info.platform != 'android') {
        throw Error("修改 JSON 文件只支持 Android")
    }
    console.log(JSON.stringify())
    let version_code = artifact_info.versionCode.toString()
    let version_name = artifact_info.versionName

    try {
        let filehandle = null;
        filehandle = await fsPromises.open(local_file_path, 'r+');
        let data = await filehandle.readFile();
        if (filehandle) filehandle.close();

        let update_conf = JSON.parse(data)

        if (release_type == 'website') {
            if (notIsStrEmpty(version_code)) update_conf['APK']['versionCode'] = version_code
            if (notIsStrEmpty(version_name)) update_conf['APK']['versionName'] = version_name
            if (notIsStrEmpty(changelog_en)) update_conf['APK']['changelog_en'] = changelog_en
            if (notIsStrEmpty(changelog_cn)) update_conf['APK']['changelog_cn'] = changelog_cn
            if (notIsStrEmpty(force_versionCode)) update_conf['APK']['force_versionCode'] = force_versionCode


            if (notIsStrEmpty(download_url)) {
                let app_path = download_url.replace("onekey.243096.com", "onekey-asset.com")
                if (app_path) update_conf['APK']['url'] = app_path
            }


            let file_size = undefined
            try {
                let file_state = await fsPromises.stat(apk_file_path)
                file_size = file_state.size
            } catch (error) {
                console.error(error)
            }
            if (file_size) update_conf['APK']['size'] = parseInt(file_size / 1024.0 / 1024) + 'M'

            if (notIsStrEmpty(sha256sum_asc_url)) update_conf['APK']['sha256sum_asc'] = sha256sum_asc_url
        } else if (release_type == 'googleplay') {
            if (!update_conf['APK']['googlePlay']) update_conf['APK']['googlePlay'] = {}
            if (notIsStrEmpty(version_code)) update_conf['APK']['googlePlay']['versionCode'] = version_code
            if (notIsStrEmpty(version_name)) update_conf['APK']['googlePlay']['versionName'] = version_name
            if (notIsStrEmpty(changelog_en)) update_conf['APK']['googlePlay']['changelog_en'] = changelog_en
            if (notIsStrEmpty(changelog_cn)) update_conf['APK']['googlePlay']['changelog_cn'] = changelog_cn
            if (notIsStrEmpty(force_versionCode)) update_conf['APK']['googlePlay']['force_versionCode'] = force_versionCode
        }

        console.log('====> ' + file_path_name + ' modiry!')
        if (release_type) console.log('release_type:' + release_type)
        if (notIsStrEmpty(version_code)) console.log('version_code:' + version_code)
        if (notIsStrEmpty(version_name)) console.log('version_name:' + version_name)
        if (notIsStrEmpty(changelog_en)) console.log('changelog_en:' + changelog_en)
        if (notIsStrEmpty(changelog_cn)) console.log('changelog_cn:' + changelog_cn)
        if (notIsStrEmpty(force_versionCode)) console.log('force_versionCode:' + force_versionCode)

        let formattedStr = JSON.stringify(update_conf, null, 4);

        if (formattedStr && formattedStr.trim() != '') {
            filehandle = await fsPromises.open(local_file_path, 'w');
            await filehandle.writeFile(formattedStr);
            if (filehandle) filehandle.close();
            console.log('<==== ' + file_path_name + ' save.')
        }
    } catch (e) {
        console.error(e)
    }
}

async function main() {

    // --a={a}
    // upload_firim
    // upload_qiniu
    // upload_qiniu_file
    // update_version

    // 打印命令行解析后的对象信息
    for (let key in argv) {
        console.log('key => %s | value => %s', key, argv[key]);
    }
    switch (argv['a']) {
        case 'upload_firim':
            await fun_upload_firim()
            break;

        case 'upload_qiniu':
            return upload_qiniu().then((download_url) => {
                update_version_json(download_url)
            });

        case 'upload_qiniu_file':
            return upload_qiniu().then((download_url) => {
                update_version_json(download_url)
            });

        case 'update_version':
            return update_version_json(undefined)

        default:
            console.error("不支持的操作")
            break;
    }
}

main().catch(err => console.error(err));
