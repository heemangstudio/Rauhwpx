import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  chmod,
  cp,
  rm,
  stat,
} from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';

// Run the unchanged, streamed installer in a disposable filesystem and PID/network
// namespaces. Network, packages, providers and service managers are explicit stubs;
// archive hashing/extraction, install/chmod, channel selection and receipts are real.
test(
  'Linux installer verifies before activation, preserves Serve routes and emits private pairing configuration',
  { skip: process.platform !== 'linux', timeout: 120000 },
  async (t) => {
    const machine = spawnSync('uname', ['-m'], { encoding: 'utf8' }).stdout.trim();
    const assetArch = { x86_64: 'amd64', aarch64: 'arm64', arm64: 'arm64' }[machine];
    assert(assetArch, `Unsupported installer architecture: ${machine}`);
    const assetName = `rauhwpx-cloud-linux-${assetArch}.tar.gz`;
    const root = await mkdtemp(path.join(tmpdir(), 'rau-install-runtime-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    async function file(name, body, mode = 0o644) {
      const dest = path.join(root, name);
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, body);
      await chmod(dest, mode);
    }
    for (const dir of [
      'etc/systemd/system',
      'run',
      'tmp',
      'opt/rauhwpx-node/bin',
      'usr/local/bin',
      'var/lib',
      'fixtures',
    ])
      await mkdir(path.join(root, dir), { recursive: true });
    await file('etc/os-release', 'ID=debian\n');
    await file(
      'etc/passwd',
      'root:x:0:0:root:/root:/bin/bash\nrauhwpx-cloud:x:0:0:Cloud:/var/lib/rauhwpx-cloud:/bin/bash\n',
    );
    await file('etc/group', 'root:x:0:\nrauhwpx-cloud:x:0:\n');
    await file('etc/nsswitch.conf', 'passwd: files\ngroup: files\n');
    for (const name of ['subuid', 'subgid'])
      await file(`etc/${name}`, 'rauhwpx-cloud:100000:65536\n');
    await file('opt/rauhwpx-node/bin/node', '', 0o755);
    for (const name of ['apt-get', 'loginctl', 'systemctl', 'pkill', 'runuser'])
      await file(
        `fixtures/${name}`,
        `#!/bin/bash\nprintf '%s\\n' '${name}' \"$@\" >>/calls\n`,
        0o755,
      );
    await file(
      'usr/local/bin/cosign',
      `#!/bin/bash
if [[ "$1" == version ]]; then echo 'GitVersion: v3.1.2'; exit; fi
printf '%s\\n' "$@" >>/cosign-calls
[[ "\${COSIGN_FAIL:-0}" != 1 ]]
`,
      0o755,
    );
    await file(
      'usr/local/bin/tailscale',
      `#!/bin/bash
printf '%s\\n' "$@" >>/tailscale-calls
case "$1" in
status) echo '{"Self":{"DNSName":"review.example.ts.net."}}' ;;
serve) for arg in "$@"; do [[ "$arg" != --reset ]] || exit 78; done; printf '%s\\n' "$*" >>/serve-routes ;;
esac
`,
      0o755,
    );
    await file(
      'usr/local/bin/curl',
      `#!/bin/bash
out=; url=
while [[ $# -gt 0 ]]; do case "$1" in --output) out=$2; shift 2;; http*|file:*) url=$1; shift;; *) shift;; esac; done
echo "$url" >>/curl-calls
case "$url" in
*/releases\?*) cat /fixtures/releases.json ;;
*/v1/health) echo '{"ok":true}' ;;
*.sha256) cp /fixtures/archive.sha256 "$out" ;;
*.sigstore.json) echo '{}' >"$out" ;;
*.tar.gz) cp /fixtures/archive.tar.gz "$out" ;;
*) echo "Unexpected network request: $url" >&2; exit 79 ;;
esac
`,
      0o755,
    );
    const release = path.join(root, 'fixtures/release/cloud');
    await mkdir(path.join(release, 'src'), { recursive: true });
    await mkdir(path.join(release, 'bin'));
    await mkdir(path.join(release, 'install'));
    await writeFile(path.join(release, 'package.json'), '{"version":"1.2.3"}');
    await writeFile(
      path.join(release, 'src/main.mjs'),
      '// runtime boundary fixture',
    );
    for (const name of [
      'rauhwpx-cloud.service',
      'rauhwpx-cloud-update.service',
      'rauhwpx-cloud-update.timer',
      'Containerfile.worker',
    ])
      await cp(
        new URL(`../install/${name}`, import.meta.url),
        path.join(release, 'install', name),
      );
    await writeFile(path.join(release, 'install/setup.sh'), '#!/bin/bash\n');
    const cli =
      '#!/bin/bash\nif [[ "$1" == pairing ]]; then echo \'{"serverPublicKey":"fixture-public-key","code":"fixture-code"}\'; else echo "$*" >>/provider-calls; fi\n';
    for (const destination of ['bin/rauhwpx-cloud', 'install/rauhwpx-cloud']) {
      await writeFile(path.join(release, destination), cli);
      await chmod(path.join(release, destination), 0o755);
    }
    const archive = path.join(root, 'fixtures/archive.tar.gz');
    assert.equal(
      spawnSync('tar', [
        '--owner=0',
        '--group=0',
        '-czf',
        archive,
        '-C',
        path.dirname(release),
        'cloud',
      ]).status,
      0,
    );
    const digest = createHash('sha256')
      .update(await readFile(archive))
      .digest('hex');
    const assets = (tag) => [
      {
        name: assetName,
        browser_download_url: `https://fixture.invalid/${tag}/${assetName}`,
      },
    ];
    await file(
      'fixtures/releases.json',
      JSON.stringify([
        { prerelease: true, draft: false, assets: assets('preview') },
        { prerelease: false, draft: false, assets: assets('stable') },
      ]),
    );
    const script = await readFile(
      new URL('../install/install.sh', import.meta.url),
      'utf8',
    );
    const binds = [
      '--ro-bind',
      '/usr',
      '/usr',
      '--bind',
      path.join(root, 'usr/local'),
      '/usr/local',
      '--ro-bind',
      '/lib',
      '/lib',
      '--symlink',
      'usr/bin',
      '/bin',
      '--symlink',
      'usr/sbin',
      '/sbin',
      '--proc',
      '/proc',
      '--dev',
      '/dev',
      '--ro-bind',
      process.execPath,
      '/opt/rauhwpx-node/bin/node',
    ];
    // ARM64 runners resolve their loader through /lib; /lib64 is x86-specific.
    if (existsSync('/lib64')) binds.push('--ro-bind', '/lib64', '/lib64');
    for (const name of ['apt-get', 'loginctl', 'systemctl', 'pkill'])
      await cp(
        path.join(root, `fixtures/${name}`),
        path.join(root, `usr/local/bin/${name}`),
      );
    binds.push(
      '--ro-bind',
      path.join(root, 'fixtures/runuser'),
      '/usr/sbin/runuser',
    );
    for (const scenario of [
      { channel: 'stable', hashFail: true },
      { channel: 'stable', signatureFail: true },
      { channel: 'stable' },
      { channel: 'prerelease' },
    ]) {
      await file(
        'fixtures/archive.sha256',
        `${scenario.hashFail ? '0'.repeat(64) : digest}  ${assetName}\n`,
      );
      await file('serve-routes', 'existing-service /already-in-use\n');
      const args = [
        '--die-with-parent',
        '--unshare-user',
        '--uid',
        '0',
        '--gid',
        '0',
        '--unshare-pid',
        '--unshare-net',
        '--unshare-ipc',
        '--unshare-uts',
        '--bind',
        root,
        '/',
        ...binds,
        '--setenv',
        'PATH',
        '/usr/local/bin:/usr/bin:/bin',
        '--setenv',
        'RAUHWpx_NODE_VERSION',
        process.versions.node,
        '--setenv',
        'RAUHWpx_CHANNEL',
        scenario.channel,
        '--setenv',
        'RAUHWpx_TAILSCALE_HTTPS_PORT',
        '8443',
        '--setenv',
        'COSIGN_FAIL',
        scenario.signatureFail ? '1' : '0',
        '--',
        '/bin/bash',
        '-s',
      ];
      const result = spawnSync('bwrap', args, {
        input: script,
        encoding: 'utf8',
        timeout: 25000,
      });
      if (scenario.hashFail || scenario.signatureFail) {
        assert.notEqual(result.status, 0);
        await assert.rejects(
          stat(path.join(root, 'opt/rauhwpx-cloud/current')),
          /ENOENT/,
        );
        assert.equal(
          await readFile(path.join(root, 'serve-routes'), 'utf8'),
          'existing-service /already-in-use\n',
        );
      } else {
        assert.equal(
          result.status,
          0,
          `${result.error} ${result.signal} ${result.stderr}`,
        );
        const receipt = JSON.parse(
          result.stdout.match(/RAUHWpx_RECEIPT=(.+)/)[1],
        );
        assert.deepEqual(receipt, {
          endpoint: 'https://review.example.ts.net:8443/rauhwpx-cloud',
          serverPublicKey: 'fixture-public-key',
          pairingCode: 'fixture-code',
          transport: 'tailscale',
          tailscaleHttpsPort: 8443,
        });
        assert.match(
          await readFile(path.join(root, 'serve-routes'), 'utf8'),
          /^existing-service \/already-in-use\n.*--set-path=\/rauhwpx-cloud/m,
        );
        assert.match(
          await readFile(path.join(root, 'curl-calls'), 'utf8'),
          new RegExp(
            `/${scenario.channel === 'prerelease' ? 'preview' : 'stable'}/${assetName}`,
          ),
        );
        assert.equal(
          (await stat(path.join(root, 'etc/rauhwpx-cloud.env'))).mode & 0o777,
          0o600,
        );
        assert.equal(
          (await stat(path.join(root, 'var/lib/rauhwpx-cloud/provider-auth')))
            .mode & 0o777,
          0o700,
        );
        const verify = await readFile(path.join(root, 'cosign-calls'), 'utf8');
        assert.match(verify, /--certificate-identity-regexp/);
        assert.match(
          verify,
          /--certificate-oidc-issuer\nhttps:\/\/token.actions.githubusercontent.com/,
        );
      }
      await assert.rejects(
        stat(path.join(root, 'run/rauhwpx-cloud-install.pid')),
        /ENOENT/,
      );
    }
  },
);
