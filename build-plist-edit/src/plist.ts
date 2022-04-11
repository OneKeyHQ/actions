import { InfoPlist } from "./IosConfig.d";
import fs from "fs-extra";
import plist from "@expo/plist";
import * as path from "path";

export async function getAppInfoPlistAsync(
  projectDir: string,
  projectName: string
): Promise<InfoPlist> {
  const infoPlistPath = getAppInfoPlistFilePath(projectDir, projectName);
  return ((await readPlistAsync(infoPlistPath)) ?? {}) as InfoPlist;
}

export async function setAppInfoPlistAsync(
  projectDir: string,
  projectName: string,
  plistObject: InfoPlist
) {
  const infoPlistPath = getAppInfoPlistFilePath(projectDir, projectName);
  await writePlistAsync(infoPlistPath, plistObject);
}

export async function readPlistAsync(
  plistPath: string
): Promise<object | null> {
  if (await fs.pathExists(plistPath)) {
    const expoPlistContent = await fs.readFile(plistPath, "utf8");
    try {
      return plist.parse(expoPlistContent);
    } catch (err: any) {
      err.message = `Failed to parse ${plistPath}. ${err.message}`;
      throw err;
    }
  } else {
    return null;
  }
}

export async function writePlistAsync(
  plistPath: string,
  plistObject: InfoPlist
): Promise<void> {
  const contents = plist.build(plistObject);
  await fs.mkdirp(path.dirname(plistPath));
  await fs.writeFile(plistPath, contents);
}

export function getPlistFilePath(projectRoot: string): string {
  const infoPlistPath = path.resolve(path.join(projectRoot), "Info.plist");

  const isInfoPlistPath = fs.pathExistsSync(infoPlistPath);

  if (!isInfoPlistPath) {
    throw new Error(
      `Failed to find Info.plist file for project: ${projectRoot}.`
    );
  }

  return infoPlistPath;
}

export function getAppInfoPlistFilePath(
  projectRoot: string,
  projectName: string
): string {
  return getPlistFilePath(path.join(projectRoot, "ios", projectName));
}
