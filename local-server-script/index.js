const path = require('path')
const upload_firim = require('./upload_firim');
const upload_notice = require('./upload_notice_slack');
const artifact_parser = require('./artifact_parser');

const argv = require('minimist')(process.argv.slice(2));

async function main() {
    // --a={a}
    // upload_firim
    switch (argv['a']) {
        case 'upload_firim':
            let firim_api_token = argv['firim_token']
            let changelog_cn = argv['changelog']
            let web_hook_url = argv['web_hook_url']
            let version_suffix = argv['version_suffix']
            let file_name = argv['filename']

            let custom_message_title = argv['custom_message_title']
            let custom_message_payload = argv['custom_message_payload']
            let custom_issue_url = argv['custom_issue_url']

            let apk_file_path = path.join('./apk', file_name)

            let artifact_info = await artifact_parser.parser(apk_file_path)
            artifact_info.changelog = changelog_cn

            if (artifact_info.platform == 'ios') {
                artifact_info.release_type = "Adhoc"
            }
            if (version_suffix) {
                artifact_info.versionName += "-" + version_suffix
            }

            let token = await upload_firim.get_api_token(artifact_info, firim_api_token)
            let upload_result = await upload_firim.upload_artifact(token, artifact_info, input_upload_file_path, input_custom_host, input_use_release_id)

            artifact_info.download_url = upload_result.download_url

            await upload_notice.notice(web_hook_url, artifact_info, {
                "title": custom_message_title,
                "payload": custom_message_payload,
                "issue_url": custom_issue_url,
            })
            break;

        default:
            console.error("不支持的操作")
            break;
    }
}

main().catch(err => console.error(err));
