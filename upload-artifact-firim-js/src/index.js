const core = require('@actions/core');
const firim = require('./firim');
const artifact_parser = require('./artifact_parser');

async function main() {
    const input_api_token = core.getInput('api-token', { required: true })
    const input_upload_file_path = core.getInput('upload-file-path', { required: true })
    const input_changelog = core.getInput('changelog', { required: false })
    const input_version_suffix = core.getInput('version-suffix', { required: false })
    const input_use_release_id = core.getInput('use-release-id', { required: false }) || true
    const input_ios_release_type = core.getInput('ios-release-type', { required: false }) || "Adhoc"
    const input_custom_host = core.getInput('custom-host', { required: false })

    console.log("Begin parse artifact info")
    console.log("Parsing file path: " + input_upload_file_path)

    let artifact_info = await artifact_parser.parser(input_upload_file_path)

    artifact_info.changelog = input_changelog

    if (artifact_info.platform == 'ios') {
        artifact_info.release_type = input_ios_release_type
    }
    if (input_version_suffix) {
        artifact_info.versionName += "-" + input_version_suffix
    }

    console.info("Parser artifact info:\n" + JSON.stringify(artifact_info))

    let token = await firim.get_api_token(artifact_info, input_api_token)
    let upload_result = await firim.upload_artifact(token, artifact_info, input_upload_file_path, input_custom_host, input_use_release_id)

    core.setOutput('artifact-download-url', upload_result && upload_result.download_url || '');
    core.setOutput('artifact-type', artifact_info && artifact_info.platform || '');
    core.setOutput('artifact-bundle-id', artifact_info && artifact_info.package || '');
    core.setOutput('artifact-name', artifact_info && artifact_info.name || '');
    core.setOutput('artifact-version-code', artifact_info && artifact_info.versionCode || '');
    core.setOutput('artifact-version-name', artifact_info && artifact_info.versionName || '');
}

main().catch(err => core.setFailed(err.message));