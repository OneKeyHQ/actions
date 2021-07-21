var needle = require('needle');

needle.defaults({
    open_timeout: 8 * 60 * 1000,
    read_timeout: 8 * 60 * 1000,
    response_timeout: 15 * 60 * 1000
})

function get_blob_by_base64(dataURI) {
    var base64Data = dataURI.replace(/^data:image\/\w+;base64,/, '')
    return Buffer.from(base64Data, 'base64')
}

function upload_file(url, data) {
    return new Promise((resolve, reject) => {
        needle.post(url, data, { multipart: true }, function (err, resp, body) {
            if (err) {
                console.error(err)
                return reject(new Error(`Upload failed: ${err}`))
            } else if (resp.statusCode >= 200 || resp.statusCode < 400) {
                return resolve(body)
            } else {
                console.error(resp)
                return reject(new Error(`Upload failed: ${resp}`))
            }
        });
    });
}

function upload_icon_file(param, base64) {
    try {
        var file_buffer = get_blob_by_base64(base64)
        var file_type = base64.split(';')[0].replace('data:', '')

        var data = {
            "key": param.key,
            "token": param.token,
            file: {
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
    if (artifact_info.changelog) {
        artifact_info.changelog = artifact_info.changelog.replace(/:-:/g, '\n')
    }
    var data = {
        "key": param.key,
        "token": param.token,
        "x:name": artifact_info.name,
        "x:build": artifact_info.versionCode,
        "x:version": artifact_info.versionName,
        "x:changelog": artifact_info.changelog,
        file: { file: file_path, content_type: 'multipart/form-data' }
    }

    if (artifact_info.release_type) {
        data["x:release_type"] = artifact_info.release_type
    }
    console.log(JSON.stringify({
        "url": param.upload_url,
        "file_path": file_path,
        "key": param.key,
        "x:name": artifact_info.name,
        "x:build": artifact_info.versionCode,
        "x:version": artifact_info.versionName
    }, null, 4))
    return upload_file(param.upload_url, data)
}

exports.upload_artifact = async function (params, artifact_info, upload_file_path, custom_host, use_release_id) {
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
    let result = await upload_binary_file(
        params.cert.binary,
        artifact_info,
        upload_file_path
    )
    console.info(result)
    console.log("Upload artifact success")

    let download_url = undefined
    if (custom_host) {
        download_url = custom_host + "/" + params.short
    } else {
        let download_prefix = "http://"
        if (params.download_domain_https_ready) {
            download_prefix = "https://"
        }
        download_url = download_prefix + params.download_domain + "/" + params.short
    }

    if (use_release_id && result.release_id) {
        download_url = download_url + "?release_id=" + result.release_id
    }

    if (!result.download_url) {
        throw new Error(result)
    }

    console.log("download_url: " + download_url)
    return {
        "download_url": download_url
    }
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