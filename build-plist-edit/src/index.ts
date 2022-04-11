const core = require("@actions/core");
import { getAppInfoPlistAsync, setAppInfoPlistAsync } from "./plist";

async function main() {
  const input_version_code = core.getInput("buildNumber", {
    required: true,
  });
  const input_version_name = core.getInput("versionName", {
    required: true,
  });
  const project_name = core.getInput("projectName");
  const project_path = core.getInput("dir");

  if (!project_path) return;
  console.log(`Reading info.plist from ${project_path}`);

  let infoPlist = await getAppInfoPlistAsync(project_path, project_name);

  infoPlist["CFBundleVersion"] = input_version_code;
  infoPlist["CFBundleShortVersionString"] = input_version_name;

  await setAppInfoPlistAsync(project_path, project_name, infoPlist);
}

main().catch((err) => console.error(err));