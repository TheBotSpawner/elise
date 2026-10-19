import { readFileSync } from "node:fs";

import { FuseV1Options, FuseVersion } from "@electron/fuses";
import { MakerDMG } from "@electron-forge/maker-dmg";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { VitePlugin } from "@electron-forge/plugin-vite";
import type { ForgeConfig } from "@electron-forge/shared-types";

/**
 * ELISE Desktop packaging (ADR-081): Electron Forge, one toolchain for build, installers and
 * release. Signing material only ever comes from CI secrets (never this file):
 *   Windows: WINDOWS_CERTIFICATE_FILE + WINDOWS_CERTIFICATE_PASSWORD
 *   macOS:   APPLE_SIGNING_IDENTITY, APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID
 * Without them the build is unsigned (development only).
 */
const env = process.env;
const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const macSigning = env.APPLE_SIGNING_IDENTITY
  ? {
      osxSign: { identity: env.APPLE_SIGNING_IDENTITY },
      ...(env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID
        ? {
            osxNotarize: {
              appleId: env.APPLE_ID,
              appleIdPassword: env.APPLE_APP_SPECIFIC_PASSWORD,
              teamId: env.APPLE_TEAM_ID,
            },
          }
        : {}),
    }
  : {};

const config: ForgeConfig = {
  packagerConfig: {
    name: "ELISE",
    executableName: "elise",
    appBundleId: "com.elise.desktop",
    asar: true,
    extraResource: ["assets"],
    protocols: [{ name: "ELISE", schemes: ["elise"] }],
    ...macSigning,
  },
  makers: [
    new MakerSquirrel({
      // The package id: the install folder (%LocalAppData%\elise_desktop), the uninstall entry
      // and the update feed all hang on it — never change it after a release.
      name: "elise_desktop",
      title: "ELISE",
      setupExe: `ELISE-Setup-${version}.exe`,
      ...(env.WINDOWS_CERTIFICATE_FILE
        ? {
            certificateFile: env.WINDOWS_CERTIFICATE_FILE,
            certificatePassword: env.WINDOWS_CERTIFICATE_PASSWORD,
          }
        : {}),
    }),
    // macOS: ZIP is what the auto-updater consumes; DMG is what people download.
    new MakerZIP({}, ["darwin"]),
    new MakerDMG({ name: "ELISE" }),
  ],
  // Publication is desktop/scripts/publish-release.mjs (ADR-084), not Forge publishers.
  plugins: [
    new VitePlugin({
      build: [
        { entry: { main: "src/main/index.ts" }, config: "vite.main.config.ts", target: "main" },
        {
          entry: { preload: "src/preload/index.ts" },
          config: "vite.preload.config.ts",
          target: "preload",
        },
        // The local runtime: its own process (utilityProcess), independent of any window.
        {
          entry: { runtime: "src/runtime/index.ts" },
          config: "vite.main.config.ts",
          target: "main",
        },
      ],
      renderer: [{ name: "main_window", config: "vite.renderer.config.ts" }],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
