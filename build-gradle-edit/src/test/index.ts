import {
  readBuildGradleAsync,
  writeBuildGradleAsync,
  setVersionCode,
  setVersionName,
  setApplicationId,
} from "../gradleUtils";

async function main() {
  const input_version_code = 123;
  const input_version_name = "test-dev";
  const project_path = "../../../frontend-monorepo/packages/app";
  const input_package_name = "com.test.app.dev";

  if (!project_path) return;
  console.log(`Reading build.gradle from ${project_path}`);

  let buildGradle = await readBuildGradleAsync(project_path);

  buildGradle = setVersionCode(input_version_code, buildGradle);
  buildGradle = setVersionName(input_version_name, buildGradle);
  buildGradle = setApplicationId(input_package_name, buildGradle);

  await writeBuildGradleAsync({
    projectDir: project_path,
    buildGradle: buildGradle,
  });
}

main().catch((err) => console.error(err));
