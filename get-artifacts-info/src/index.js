const core = require('@actions/core');
const AppInfoParser = require('app-info-parser')

async function main() {
    const input_artifact_file_path = core.getInput('artifact-file-path', { required: true })
    const input_version_suffix = core.getInput('version-suffix')

    const parser = new AppInfoParser(input_artifact_file_path) // or xxx.ipa
    let artifact_info = await parser.parse().then(result => {
        var data = undefined
        if (result.versionCode) {
            // android
            data = {
                "platform": "android",
                "name": result.application.label[0],
                "versionCode": result.versionCode,
                "versionName": result.versionName,
                "package": result.package,
                "icon": result.icon,
            }
        } else {
            // ios
            data = {
                "platform": "ios",
                "name": result.CFBundleName,
                "versionCode": result.CFBundleVersion,
                "versionName": result.CFBundleShortVersionString,
                "package": result.CFBundleIdentifier,
                "icon": result.icon,
            }
        }
        return data
    })

    if (artifact_info.platform == 'ios') {
        artifact_info.release_type = input_ios_release_type
    }

    console.info("Parser artifact info:\n" + JSON.stringify(artifact_info))

    let versionName = undefined
    if (input_version_suffix) {
        versionName = artifact_info && artifact_info.versionName || ''
    } else {
        versionName = artifact_info.versionName + "-" + input_version_suffix
    }

    core.setOutput('artifact-type', artifact_info && artifact_info.platform || '');
    core.setOutput('artifact-bundle-id', artifact_info && artifact_info.package || '');
    core.setOutput('artifact-name', artifact_info && artifact_info.name || '');
    core.setOutput('artifact-version-code', artifact_info && artifact_info.versionCode || '');
    core.setOutput('artifact-version-name', versionName);
}

main().catch(err => core.setFailed(err.message));
