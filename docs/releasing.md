# Desktop releases

Tagged releases publish signed and notarized macOS arm64 DMG/ZIP files, an unsigned Windows x64 NSIS installer, and Linux x64/arm64 AppImage and Debian packages. Windows users can see SmartScreen warnings.

## Tagged release

Update the version in `package.json` and both version fields in `package-lock.json`. Run `npm run test:ci` and `npm run check:docs`, commit the changes, then push the matching `v<version>` tag. The workflow rejects a tag that does not match `package.json` before building.

```sh
git tag "v$(node -p "require('./package.json').version")"
git push origin "v$(node -p "require('./package.json').version")"
```

[release.yml](../.github/workflows/release.yml) verifies the tagged source and publishes after all desktop builds succeed. The GitHub release contains installers, update metadata and SHA-256 checksums.

Run the full engine, browser, and agent suites through pull-request CI before merging. Tagged releases run repository and release contract checks and installer verification. They do not repeat the full Rust workspace test build or the application integration suites.

## Nightly verification

[Nightly verification](../.github/workflows/nightly.yml) runs daily at 03:00 Asia/Seoul (`0 18 * * *` UTC) on Blacksmith and also supports manual verification runs. It runs the Rust workspace tests and audits, builds the WASM engine, and uses that exact build for application, browser and security checks. Nightly installer builds and GitHub Release publication are disabled.

## Installing desktop updates

The desktop updater installs only after the user chooses **Restart to install** or **Install now**, approves document closure, and the app stops its agent hub. The final handoff uses `electron-updater.quitAndInstall()` on macOS, Windows, and AppImage builds. On macOS, this also waits for the native updater to stage the downloaded archive before restarting. Keep `autoInstallOnAppQuit` disabled so ordinary quits cannot start an installer outside this flow.

Choosing **Later** or canceling document closure preserves the downloaded update. **Check for Updates** offers it again. Debian packages continue to use the system package manager.

Users on 2.0.1 or earlier should download and install 2.0.2 manually once. The 2.0.2 release fixes the in-app installation handoff. Publish a new version for updater fixes instead of replacing assets under an existing version tag.

## Signing and package checks

Tagged desktop releases use [.github/actions/package-desktop](../.github/actions/package-desktop/action.yml) for macOS and Windows setup, builds and verification. Tagged Linux releases build on native x64 and arm64 runners. macOS jobs use the `macos-release` environment and require these secrets:

- `MACOS_CERTIFICATE`
- `MACOS_CERTIFICATE_PASSWORD`
- `APPLE_ID`
- `APPLE_TEAM_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`

Missing secrets fail the macOS job. If the environment requires a reviewer, GitHub waits for that approval. Tagged publication requires every desktop build, so a failed macOS job blocks the release.

Keep packaged runtime checks, artifact architecture checks, Developer ID verification and notarization validation when changing this workflow. npm production dependency audits block high and critical advisories. Nightly also reports lower-severity findings for maintenance review.

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

Desktop, Studio's About dialog, and extension viewer About dialogs display the product version from the root `package.json`. The PWA and extension names use HamaEditor. Engine crates, extension manifests and published npm packages keep their own versions and identifiers. Those values control package compatibility and store updates; changing the product version does not automatically bump them. Historical `rhwp` paths and upstream attribution remain intact.
