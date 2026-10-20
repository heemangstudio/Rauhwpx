# Desktop releases

Tagged releases publish signed and notarized macOS arm64 DMG/ZIP files and an unsigned Windows x64 NSIS installer. Linux installers remain local builds via `npm run dist:linux:*`.

## Tagged release

Update the version in `package.json` and both version fields in `package-lock.json`. Run `npm run test:ci` and `npm run check:docs`, commit the changes, then push the matching `v<version>` tag. The workflow rejects a tag that does not match `package.json` before building.

```sh
git tag "v$(node -p "require('./package.json').version")"
git push origin "v$(node -p "require('./package.json').version")"
```

[release.yml](../.github/workflows/release.yml) verifies the tagged source and publishes after all desktop builds succeed. The GitHub release contains installers, update metadata and SHA-256 checksums.

Installed apps update from, and the website downloads from, the public [heemangstudio/hamaeditor-releases](https://github.com/heemangstudio/hamaeditor-releases) repository, so this source repository can be private. The publish job copies every release there with fixed `HamaEditor-mac-arm64.dmg` and `HamaEditor-win-x64.exe` aliases through `releases/latest/download`. Both aliases are included in `SHA256SUMS.txt`. Versioned Windows installers, their blockmaps and `latest.yml` must also be published there: Windows updates follow that descriptor, not the stable download alias. It needs the `RELEASES_TOKEN` repository secret: a fine-grained token with Contents read and write on that repository only.

Pull-request CI runs the engine and agent suites; browser, smoke and macOS session tests run nightly, so check the latest nightly run before tagging. Tagged releases run repository and release contract checks and installer verification. They do not repeat the full Rust workspace test build or the application integration suites.

## Nightly verification

[Nightly verification](../.github/workflows/nightly.yml) runs daily at 03:00 Asia/Seoul (`0 18 * * *` UTC) and also supports manual verification runs. Linux jobs run on Blacksmith; the macOS and Windows jobs run on GitHub-hosted runners. A scheduled run skips every job when the last successful nightly on the same branch tested the same commit; a manual run always runs unless started with `force` off. It runs the Rust workspace tests and audits, the macOS session tests, builds the WASM engine, and uses that exact build for application, browser and security checks. Nightly installer builds and GitHub Release publication are disabled.

## Installing desktop updates

Packaged builds check for updates 4 seconds after launch and hourly after that, and download only when the user chooses to on the document home screen. There are no native update dialogs: main broadcasts one update state to every window (`desktop:update-state`). Restarting asks every window for its open documents, writes `update-restart.json` to the user data folder, closes the windows without the Save/Discard prompt and stops the agent hub. The final handoff uses `electron-updater.quitAndInstall()` on macOS, Windows, and AppImage builds; Windows runs the NSIS installer silently and relaunches the app. On macOS, this also waits for the native updater to stage the downloaded archive before restarting. The next launch reopens those windows from the manifest when it is less than 30 minutes old, and offers the update again if the version did not change. If the handoff fails, the app relaunches itself instead of calling `quitAndInstall()` a second time. Keep `autoInstallOnAppQuit` disabled so ordinary quits cannot start an installer outside this flow. Debian packages continue to use the system package manager; their update action opens the release download.

To try the flow from source, start Studio with `npm run dev:studio` and run `RHWP_FAKE_UPDATE=3.0.3 npm run dev:desktop`. The app offers 3.0.3, simulates a three-second download, and restarts through the same restore path without installing. Packaged builds ignore the variable.

Users on 2.0.1 or earlier should download and install 2.0.2 manually once. The 2.0.2 release fixes the in-app installation handoff. Publish a new version for updater fixes instead of replacing assets under an existing version tag.

2.0.11 shipped with the app id `com.hataewook.hamaeditor`. On macOS the bundle id is back to `com.hataewook.rauhwpx`, so 2.0.10 and earlier update in place, while the 2.0.11 updater cannot install later releases and its users download the DMG once. On Windows `nsis.guid` keeps the 2.0.11 install identity, because the install folder and shortcuts follow the product name: 2.0.11 updates in place, and 2.0.10 installs the new version beside the old `Rauhwpx` entry, which can then be uninstalled. Both share one user data folder. On first launch the app imports chats, drafts, versions, settings and agent data that 2.0.11 kept under its own names and leaves those folders untouched. API keys saved in 2.0.11 are not imported because 2.0.11 encrypted them with its own Keychain item; users enter them again.

## Signing and package checks

Tagged desktop releases use [.github/actions/package-desktop](../.github/actions/package-desktop/action.yml) for macOS and Windows setup, builds and verification. Both reuse the same Linux-built WASM artifact, avoiding the Windows Binaryen crash. Windows builds and verifies the native x64 extractor, packaged runtime, NSIS installer, blockmap and update descriptor; its unsigned-by-design signature check remains required. macOS jobs use the `macos-release` environment and require these secrets:

- `MACOS_CERTIFICATE`
- `MACOS_CERTIFICATE_PASSWORD`
- `APPLE_ID`
- `APPLE_TEAM_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`

Missing secrets fail the macOS job. If the environment requires a reviewer, GitHub waits for that approval. Tagged publication requires verification and both desktop builds, so a failed macOS or Windows job blocks the release.

Keep packaged runtime checks, artifact architecture checks, Developer ID verification and notarization validation when changing this workflow. npm production dependency audits block high and critical advisories. Nightly also reports lower-severity findings for maintenance review.

The default Developer ID package has no provisioning profile. Keep restricted keychain access groups out of its entitlements: macOS rejects an executable with an unauthorized group before JavaScript starts, even after notarization succeeds. Native Electron Touch ID needs a provisioning profile authorizing its dedicated group; existing Mac passkeys use signed Chrome. See [macOS website passkeys](browser-mac-passkeys.md).

## Local builds

Complete [development setup](../CONTRIBUTING.md) first. On the target platform, `npm run dist:mac`, `npm run dist:win`, `npm run dist:linux:x64`, or `npm run dist:linux:arm64` builds and packages the app. The macOS command needs the signing credentials configured for electron-builder.

For repeated packaging with an existing build:

```sh
npm run build:desktop
npm run package:mac
npm run verify:package
```

Use `package:win` on Windows. Packaging does not reinstall dependencies or rebuild the engine. Rebuild after source changes; rerun `npm run setup` after dependency changes.

## Product and package versions

Desktop, Studio's About dialog, and extension viewer About dialogs display the product version from the root `package.json`. The PWA and extension names use HamaEditor.

Identities that address user data keep their original names: the app name Electron uses for the user data folder and the safeStorage Keychain item (`Rauhwpx` for the whole process, set in `desktop/app-identity.mjs`; menus and dialogs pass `PRODUCT_NAME` explicitly), the Studio scheme `rauhwpx://app`, the macOS bundle id `com.hataewook.rauhwpx`, the Windows installer GUID, Studio storage keys and IndexedDB names, hub data folders and secret ids (`rhwp`), and the `.rhwpx` archive signature. Renaming any of them hides existing data from users who update. Engine crates, extension manifests and published npm packages keep their own versions and identifiers. Those values control package compatibility and store updates; changing the product version does not automatically bump them. Historical `rhwp` paths and upstream attribution remain intact.
