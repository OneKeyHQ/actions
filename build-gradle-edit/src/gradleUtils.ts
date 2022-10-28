import fs from "fs-extra";
import g2js from "gradle-to-js/lib/parser";
import * as path from "path";

interface Config {
  applicationId?: string;
  versionCode?: string;
  versionName?: string;
}

interface AppBuildGradle {
  android?: {
    defaultConfig?: Config;
    flavorDimensions?: string; // e.g. '"dimension1", "dimension2"'
    productFlavors?: Record<string, Config>;
  };
}

export async function getAppBuildGradleAsync(
  projectDir: string
): Promise<AppBuildGradle> {
  const buildGradlePath = getAppBuildGradleFilePath(projectDir);
  const rawBuildGradle = await fs.readFile(buildGradlePath, "utf8");
  return await g2js.parseText(rawBuildGradle);
}

export async function readBuildGradleAsync(
  projectDir: string
): Promise<string | undefined> {
  const buildGradlePath = getAppBuildGradleFilePath(projectDir);
  if (!(await fs.pathExists(buildGradlePath))) {
    return undefined;
  }
  return await fs.readFile(buildGradlePath, "utf8");
}

export async function writeBuildGradleAsync({
  projectDir,
  buildGradle,
}: {
  projectDir: string;
  buildGradle: string;
}): Promise<void> {
  const buildGradlePath = getAppBuildGradleFilePath(projectDir);
  await fs.writeFile(buildGradlePath, buildGradle);
}

export function getGradleFilePath(
  projectRoot: string,
  gradleName: string
): string {
  const groovyPath = path.resolve(projectRoot, `${gradleName}.gradle`);
  const ktPath = path.resolve(projectRoot, `${gradleName}.gradle.kts`);

  const isGroovy = fs.pathExistsSync(groovyPath);
  const isKotlin = !isGroovy && fs.pathExistsSync(ktPath);

  if (!isGroovy && !isKotlin) {
    throw new Error(
      `Failed to find '${gradleName}.gradle' file for project: ${projectRoot}.`
    );
  }
  const filePath = isGroovy ? groovyPath : ktPath;
  return filePath;
}

export function getAppBuildGradleFilePath(projectRoot: string): string {
  return getGradleFilePath(path.join(projectRoot, "android", "app"), "build");
}

export function setVersionName(versionName: string, buildGradle: string) {
  if (versionName === null) {
    return buildGradle;
  }

  let pattern = new RegExp(`versionName ".*"`);
  if (pattern.test(buildGradle)) {
    return buildGradle.replace(pattern, `versionName "${versionName}"`);
  }
  pattern = new RegExp(`versionName .*`);
  return buildGradle.replace(pattern, `versionName "${versionName}"`);
}

export function setVersionCode(versionCode: number, buildGradle: string) {
  if (versionCode === null) {
    return buildGradle;
  }

  const pattern = new RegExp(`versionCode.*`);
  return buildGradle.replace(pattern, `versionCode ${versionCode}`);
}

export function setApplicationId(
  applicationId: string | null,
  buildGradle: string
) {
  if (applicationId == null || applicationId === "") {
    return buildGradle;
  }

  let pattern = new RegExp(`applicationId .*`);
  if (pattern.test(buildGradle)) {
    return buildGradle.replace(pattern, `applicationId "${applicationId}"`);
  }
  return buildGradle;
}
