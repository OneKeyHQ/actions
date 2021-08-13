const needle = require('needle');

// {
//     "platform": "ios",
//     "name": result.CFBundleName,
//     "versionCode": result.CFBundleVersion,
//     "versionName": result.CFBundleShortVersionString,
//     "package": result.CFBundleIdentifier,
//     "release_type": result.icon,
//     "changelog": "",
//     "download_url": "",
// }

/**
 * 
 * @param {*} web_hook_url 
 * @param {*} artifact_info 
 * @param {*} download_url 
 * @param {*} change_log 
 * @param {*} custom 
 * @returns 
 */
exports.notice = function (web_hook_url, artifact_info, custom) {
    const input_web_hook_url = web_hook_url

    let input_artifact_type = artifact_info.platform
    let input_artifact_bundle_id = artifact_info.package
    let input_artifact_download_url = artifact_info.download_url
    let input_artifact_name = artifact_info.name
    let input_artifact_version_code = artifact_info.versionCode
    let input_artifact_version_name = artifact_info.versionName
    let input_change_log = artifact_info.changelog
    let input_custom_message_title = custom.title
    let input_custom_message_payload = custom.payload
    let input_custom_issue_url = custom.issue_url

    if (input_artifact_type.toLowerCase() == 'ios') {
        input_artifact_type = "iOS"
    } else if (input_artifact_type.toLowerCase() == 'android') {
        input_artifact_type = "Android"
    }
    if (input_change_log) {
        input_change_log = input_change_log.replace(/:-:/g, '\n')
    }

    const message_title = input_artifact_type + " App [ " + input_artifact_name + " ] has a new update [ " + input_artifact_version_name + " ]"
    let data = {
        "type": "modal",
        "text": message_title,
        "blocks": [
            {
                "type": "header",
                "text": {
                    "type": "plain_text",
                    "text": message_title
                }
            },
            {
                "type": "section",
                "fields": [
                    {
                        "type": "mrkdwn",
                        "text": "*Platform*\n" + input_artifact_type
                    },
                    {
                        "type": "mrkdwn",
                        "text": "*Package*\n" + input_artifact_bundle_id
                    }
                ]
            },
            {
                "type": "section",
                "fields": [
                    {
                        "type": "mrkdwn",
                        "text": "*VersionName*\n" + input_artifact_version_name
                    },
                    {
                        "type": "mrkdwn",
                        "text": "*VersionCode*\n" + input_artifact_version_code
                    }
                ]
            },
        ],
        "attachments": [
            {
                "color": "00B812",
                "blocks": [
                    {
                        "type": "section",
                        "fields": [
                            {
                                "type": "mrkdwn",
                                "text": "*Change Log*\n" + input_change_log
                            }
                        ]
                    },
                    {
                        "type": "section",
                        "text": {
                            "type": "mrkdwn",
                            "text": "*Download link:* " + input_artifact_download_url
                        },
                        "accessory": {
                            "type": "button",
                            "text": {
                                "type": "plain_text",
                                "text": "Download",
                            },
                            "url": input_artifact_download_url,
                            "action_id": "button-action"
                        }
                    }
                ]
            }
        ]
    }

    if (input_custom_message_title && input_custom_message_title !== '') {
        data['attachments'][0]["blocks"].push({
            "type": "section",
            "fields": [
                {
                    "type": "mrkdwn",
                    "text": "*" + input_custom_message_title + "*\n" + input_custom_message_payload
                }
            ]
        })
    }

    if (input_custom_issue_url && input_custom_issue_url !== '') {
        let content_split = input_custom_issue_url.split(/[\n]|:-:/g)
        content_split.forEach(element => {
            if (element && element.trim() != '') {
                data['attachments'][0]["blocks"].push({
                    "type": "section",
                    "text": {
                        "type": "mrkdwn",
                        "text": "*Issue link:* " + element
                    },
                    "accessory": {
                        "type": "button",
                        "text": {
                            "type": "plain_text",
                            "text": "See issue",
                        },
                        "url": element,
                        "action_id": "button-" + element
                    }
                })
            }
        })
    }
    return needle('post', input_web_hook_url, data, { json: true })
}
