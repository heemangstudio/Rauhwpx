# Rebuilding the production dependencies

The local tarball is a source rebuild of the official commit recorded in `provenance.json`. It repairs embedded code that root dependency overrides cannot replace. The downstream version identifies this private build; the package has not been published to a registry.

Fetch the source archive URL in the provenance record and verify its SHA-256 before extraction. Use a separate scratch directory and a separate npm cache. Install with lifecycle scripts disabled. The recorded builds used Node 26.7.0 and npm 11.19.0, with `GOMAXPROCS=2` and `NODE_OPTIONS=--max-old-space-size=1024`. Do not use the upstream release/publish scripts.

For npm, set the source package version to `11.19.2-rau.2`. Add these root overrides:

```json
{"minimatch@^10.2.5":{"brace-expansion":"5.0.12"},"node-gyp@^12.4.0":{"undici":"6.28.1"},"http-cache-semantics":"4.3.0","ip-address":"10.7.3"}
```

Run `npm install --package-lock-only --ignore-scripts --no-audit --no-fund`, then targeted `npm update http-cache-semantics ip-address --package-lock-only --ignore-scripts --no-audit --no-fund`. Check the source lock diff: only the root version, existing brace-expansion/undici fixes and the http-cache-semantics/ip-address resolutions may change. Run `npm ci --ignore-scripts --no-audit --no-fund`, `npm run build --workspace docs`, then `npm pack --ignore-scripts --pack-destination <output>`. Preserve the `bin/npm-cli.js` layout and verify the packed dependency source and versions.

The npm refresh uses upstream stable http-cache-semantics 4.3.0. It is outside [GHSA-ch52-4w7c-c8xp](https://github.com/advisories/GHSA-ch52-4w7c-c8xp)'s affected range; the upstream maintainer [disputes the report](https://github.com/github/advisory-database/issues/10139). The release changes Vary matching and status reporting, preserving upstream max-stale behavior. No downstream cache policy patch or audit exception is applied.

Replace the local tarball, record its new SHA-256 and source input hashes, then regenerate the consuming lockfile using `npm install --package-lock-only --ignore-scripts`. npm file-tarball manifests strip the registry shrinkwrap marker, so the consuming lock remains authoritative. Regenerate in a physical scratch directory with the carrier lock entries removed, then run an actual `npm install --ignore-scripts` to record all real bundled nodes. Check that every unrelated resolution stays unchanged. Do not hand-edit nested dependency versions. Run fresh `npm ci`, `npm run audit:production` across every production directory, and the tooling/provider/runtime checks. The audit gate has no exceptions.

The Electron agent glob includes the agent vendor directory. Retire this rebuild when a verified upstream artifact fixes both the installed dependency tree and embedded runtime code.

The npm artifact retains the upstream Artistic License 2.0 and license files.
