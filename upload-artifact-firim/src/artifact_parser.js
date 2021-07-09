const AppInfoParser = require('app-info-parser')

exports.parser = function (path) {
    const parser = new AppInfoParser(path) // or xxx.ipa
    return parser.parse().then(result => {
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
}
