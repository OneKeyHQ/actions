const core = require('@actions/core');
var needle = require('needle');

async function main() {
    const input_web_hook_url = core.getInput('web-hook-url', { required: true })

    let input_artifact_type = core.getInput('artifact-type', { required: false })
    let input_artifact_bundle_id = core.getInput('artifact-bundle-id', { required: false })
    let input_artifact_download_url = core.getInput('artifact-download-url', { required: false })
    let input_artifact_name = core.getInput('artifact-name', { required: false })
    let input_artifact_version_code = core.getInput('artifact-version-code', { required: false })
    let input_artifact_version_name = core.getInput('artifact-version-name', { required: false })
    let input_change_log = core.getInput('change-log', { required: false })
    let input_custom_message_title = core.getInput('custom-message-title', { required: false })
    let input_custom_message_payload = core.getInput('custom-message-payload', { required: false })
    let input_custom_issue_url = core.getInput('custom-issue-url', { required: false })

    if (input_artifact_type.toLowerCase() == 'ios') {
        input_artifact_type = "iOS"
    } else if (input_artifact_type.toLowerCase() == 'android') {
        input_artifact_type = "Android"
    }
    if (input_change_log) {
        input_change_log = input_change_log.replace(/:-:/g, '\n')
    }

    let data = {
        "type": "modal",
        "blocks": [
            {
                "type": "header",
                "text": {
                    "type": "plain_text",
                    "text": input_artifact_type + " App [ " + input_artifact_name + " ] has a new update [ " + input_artifact_version_name + " ]"
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

    if (input_custom_message_title) {
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

    if (input_custom_issue_url) {
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
    await needle('post', input_web_hook_url, data, { json: true })
}

main().catch(err => core.setFailed(err.message));
