# Rebuilding the production provider dependencies

The local tarballs are source rebuilds of the official commits recorded in `provenance.json`. They repair embedded code that root dependency overrides cannot replace. The downstream versions identify these private builds; these packages have not been published to a registry.

Fetch the source archive URL in the provenance record and verify its SHA-256 before extraction. Use a separate scratch directory and a separate npm cache. Install with lifecycle scripts disabled. The recorded builds used Node 26.7.0 and npm 11.19.0, with `GOMAXPROCS=2` and `NODE_OPTIONS=--max-old-space-size=1024`. Do not use the upstream release/publish scripts.

For npm, set the source package version to `11.19.2-rau.1`. Add these root overrides:

```json
{"minimatch@^10.2.5":{"brace-expansion":"5.0.12"},"node-gyp@^12.4.0":{"undici":"6.28.1"}}
```

Run `npm install --package-lock-only --ignore-scripts --no-audit --no-fund`, then targeted `npm update brace-expansion undici --package-lock-only --ignore-scripts --no-audit --no-fund`. Check the source lock diff: only the root version and the two patched dependency resolutions may change. Run `npm ci --ignore-scripts --no-audit --no-fund`, `npm run build --workspace docs`, then `npm pack --ignore-scripts --pack-destination <output>`. Preserve the `bin/npm-cli.js` layout and verify the packed dependency source and versions.

For Pi, fetch and integrity-check the matching `pi-ai 0.87.1` tarball recorded under `modelData`; its gitHead must equal the source commit. Copy only `package/dist/providers/data` unchanged into `packages/ai/src/providers/data`. First install the original source lock with `npm ci --ignore-scripts --no-audit --no-fund` and run `npm run build:offline`. All 56 files under `packages/coding-agent/dist/bundle` must reproduce the official `pi-coding-agent 0.87.1` tarball byte-for-byte. Do not regenerate model data from remote APIs.

Then add the root override `"minimatch@10.2.6":{"brace-expansion":"5.0.12"}` beside the existing protobufjs override. Set only the coding-agent workspace version to `0.87.2-rau.1`. Run `npm install --package-lock-only --ignore-scripts --no-audit --no-fund`, then `npm update brace-expansion --package-lock-only --ignore-scripts --no-audit --no-fund`. Check that only brace-expansion resolution and the coding-agent workspace version change. Run `npm ci --ignore-scripts --no-audit --no-fund`, `npm run build:offline`, `npm run shrinkwrap:coding-agent`, `npm run check:shrinkwrap`, and `npm pack --ignore-scripts --workspace @earendil-works/pi-coding-agent --pack-destination <output>`.

Inspect the packed Pi shrinkwrap and actual esbuild chunk. Both must contain the fixed dependency. The new parser must have iterative comma parsing, depth and rewrite bounds. Check ordinary brace patterns against the baseline and run the advisory inputs with time/memory limits. The rebuilt package retains the upstream file count; changes are the package manifest, shrinkwrap, corrected chunk and importing chunk hashes.

Replace the local tarball, record its new SHA-256 and source input hashes, then regenerate the consuming lockfile using `npm install --package-lock-only --ignore-scripts`. For Pi, also retain the consuming root override `"minimatch@10.2.6":{"brace-expansion":"5.0.12"}` and use targeted `npm update brace-expansion --package-lock-only --ignore-scripts` to regenerate its installed dependency resolution. npm file-tarball manifests strip the registry shrinkwrap marker, so the consuming lock remains authoritative. For npm, regenerate in a physical scratch directory with the carrier lock entries removed, then run an actual `npm install --ignore-scripts` to record all real bundled nodes. Check that every unrelated resolution stays unchanged. Do not hand-edit nested dependency versions. Run fresh `npm ci`, `npm run audit:production` across all six directories, and the tooling/provider/runtime checks. The audit gate has no exceptions.

The cloud staging installer copies the provider `vendor` directory, and both cloud Containerfiles copy the provider and agent artifacts before installation. The existing runtime-assets archive and Electron agent glob include the agent vendor directory. Retire these rebuilds when verified upstream artifacts fix both the installed dependency tree and embedded runtime code.
