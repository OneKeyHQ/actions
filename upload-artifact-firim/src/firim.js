var needle = require('needle');

function get_blob_by_base64(dataURI) {
    var base64Data = dataURI.replace(/^data:image\/\w+;base64,/, '')
    return Buffer.from(base64Data, 'base64')
}

function upload_file(url, data) {
    return needle('post', url, data, { multipart: true })
        .then((result) => result.body)
}

function upload_icon_file(param, base64) {
    try {
        var file_buffer = get_blob_by_base64(base64)
        var file_type = base64.split(';')[0].replace('data:', '')
        var data = {
            "key": param.key,
            "token": param.token,
            "file": {
                buffer: file_buffer,
                content_type: file_type
            }
        }
        return upload_file(param.upload_url, data)
    } catch (error) {
        console.error(error)
    }
}

function upload_binary_file(param, artifact_info, file_path) {
    var data = {
        "key": param.key,
        "token": param.token,
        "x:name": artifact_info.name,
        "x:build": artifact_info.versionCode,
        "x:version": artifact_info.versionName,
        "x:changelog": artifact_info.changelog,
        "file": { file: file_path, content_type: 'multipart/form-data' }
    }

    if (artifact_info.release_type) {
        data["x:release_type"] = artifact_info.release_type
    }

    return upload_file(param.upload_url, data)
}

exports.upload_artifact = async function (params, artifact_info, upload_file_path, use_release_id) {
    try {
        console.log("Begin upload icon to firim")
        await upload_icon_file(
            params.cert.icon,
            artifact_info.icon
        )
    } catch (error) {
        console.log("Upload icon error: " + JSON.stringify(error))
    }
    console.log("Upload icon success")

    console.log("Begin upload artifact to firim")
    return upload_binary_file(
        params.cert.binary,
        artifact_info,
        upload_file_path
    )
        .then((result) => {
            console.log("Upload artifact success")

            var download_url = "http://" + params.download_domain + "/" + params.short
            if (use_release_id) {
                download_url = download_url + "?release_id=" + result.release_id
            }

            return {
                "download_url": download_url
            }
        })
}

exports.get_api_token = function (artifact_info, api_token) {
    console.log("Login firim ...")
    return needle('post', 'http://api.bq04.com/apps',
        {
            "type": artifact_info.platform,
            "bundle_id": artifact_info.package,
            "api_token": api_token
        },
        { json: true })
        .then((result) => result.body)
}
