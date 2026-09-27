import { spawn as nodeSpawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { normalizeSshConfig, normalizeTailscaleHttpsPort, sshOptionFilePath } from './cloud-profile.mjs';

const OUTPUT_LIMIT = 2 * 1024 * 1024;
const BOOTSTRAP_LIMIT = 1024 * 1024 * 1024;
const DEV_SHA256_RE = /^[a-f0-9]{64}$/;
const INSTALL_TIMEOUT_MS = 30 * 60_000;
const EXPECTED_CLOUD_PROTOCOL = 1;
const CHANNELS = new Set(['stable', 'prerelease']);
const SSH_RETRY_ATTEMPTS = 3;

const TRANSIENT_SSH_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
]);

const TRANSIENT_SSH_MESSAGE = /(?:connection (?:closed|refused|reset|timed out)|connection to .* closed|broken pipe|connection reset by peer|could not resolve hostname|host is down|kex_exchange_identification|network is (?:down|unreachable)|no route to host|operation timed out|ssh_exchange_identification|temporary failure in name resolution)/i;

function stripControl(value) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

function runProcess(spawnImpl, command, args, { input, timeoutMs = 30_000, onLine = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    });
    const stdout = [];
    const stderr = [];
    const carry = { stdout: '', stderr: '' };
    let outputSize = 0;
    let settled = false;
    const emitLogLine = (line) => {
      if (!line) return;
      onLine(line.startsWith('RAUHWpx_RECEIPT=') ? 'RAUHWpx_RECEIPT=' : line);
    };
    const capture = (target, stream, chunk) => {
      outputSize += chunk.length;
      if (outputSize > OUTPUT_LIMIT) {
        child.kill('SIGKILL');
        rejectOnce(new Error('SSH output exceeded the safety limit'));
        return;
      }
      target.push(chunk);
      const text = carry[stream] + stripControl(chunk.toString('utf8'));
      const lines = text.split(/\r?\n/);
      carry[stream] = lines.pop() ?? '';
      for (const line of lines) emitLogLine(line);
    };
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectOnce(Object.assign(new Error(`${command} timed out`), { code: 'ETIMEDOUT' }));
    }, timeoutMs);
    child.once('error', rejectOnce);
    // SSH can reject a command before Electron finishes streaming an installer
    // or bootstrap archive. A pipe then reports EPIPE on stdin; without an
    // error listener Node treats it as an uncaught process error.
    child.stdin?.on('error', (cause) => {
      const error = Object.assign(
        new Error(`${command} input failed: ${cause.message}`),
        { code: cause.code || 'SSH_STDIN_FAILED', cause },
      );
      child.kill('SIGTERM');
      rejectOnce(error);
    });
    child.stdout.on('data', (chunk) => capture(stdout, 'stdout', chunk));
    child.stderr.on('data', (chunk) => capture(stderr, 'stderr', chunk));
    child.once('close', (code, signal) => {
      emitLogLine(carry.stdout);
      emitLogLine(carry.stderr);
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result = {
        code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      };
      if (code === 0) resolve(result);
      else {
        const detail = stripControl(result.stderr || result.stdout).trim().slice(-1200);
        const error = new Error(`${command} exited with ${code ?? signal}${detail ? `: ${detail}` : ''}`);
        error.result = result;
        reject(error);
      }
    });
    try {
      if (input != null) child.stdin.end(input);
      else child.stdin.end();
    } catch (cause) {
      child.kill('SIGTERM');
      rejectOnce(Object.assign(
        new Error(`${command} input failed: ${cause.message}`),
        { code: cause.code || 'SSH_STDIN_FAILED', cause },
      ));
    }
  });
}

function transientSshFailure(error) {
  if (TRANSIENT_SSH_CODES.has(String(error?.code ?? '').toUpperCase())) return true;
  if (Number(error?.result?.code) !== 255) return false;
  return TRANSIENT_SSH_MESSAGE.test(String(error?.message ?? ''));
}

async function retryTransientSsh(operation, {
  attempts = SSH_RETRY_ATTEMPTS,
  onLine = () => {},
  sleep = (ms) => delay(ms),
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !transientSshFailure(error)) throw error;
      onLine(`SSH connection was interrupted; retrying (${attempt + 1}/${attempts})`);
      await sleep(Math.min(1_000, 200 * (2 ** (attempt - 1))));
    }
  }
  throw lastError;
}

function sshDestination(ssh) {
  return `${ssh.user}@${ssh.host}`;
}

const HOST_ENV_KEYS = Object.freeze([
  'RAUHWpx_HOST_KIND',
  'RAUHWpx_BOAT_SANDBOX_ID',
  'RAUHWpx_BOAT_IDLE_MINUTES',
  'RAUHWpx_BOAT_USER',
]);
const NO_HOST_ENV = Object.freeze({ kind: '', assignments: Object.freeze([]) });
const BOAT_ENV_FILE = '/etc/rauhwpx-boat.env';

/**
 * 설치 스크립트에 넘기는 호스트 설정. 원격 셸에 그대로 이어 붙이므로 값마다 좁은
 * 정규식을 통과해야 하고, 모르는 키는 거절한다.
 */
export function normalizeHostEnv(raw, { transport } = {}) {
  if (raw == null) return NO_HOST_ENV;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Cloud host settings are invalid');
  for (const key of Object.keys(raw)) {
    if (!HOST_ENV_KEYS.includes(key)) throw new Error('Cloud host settings contain an unsupported key');
  }
  const kind = String(raw.RAUHWpx_HOST_KIND ?? '');
  if (kind !== '' && kind !== 'boat') throw new Error('Cloud host kind must be empty or boat');
  if (kind === '') {
    if (HOST_ENV_KEYS.slice(1).some((key) => raw[key] != null && raw[key] !== '')) {
      throw new Error('boat host settings require the boat host kind');
    }
    return NO_HOST_ENV;
  }
  if (transport !== 'ssh-tunnel') throw new Error('boat Cloud hosts require the SSH tunnel transport');
  const sandboxId = String(raw.RAUHWpx_BOAT_SANDBOX_ID ?? '');
  if (!/^bx_[a-z0-9]{8}$/.test(sandboxId)) throw new Error('boat sandbox id is invalid');
  const idleText = raw.RAUHWpx_BOAT_IDLE_MINUTES == null || raw.RAUHWpx_BOAT_IDLE_MINUTES === ''
    ? '30'
    : String(raw.RAUHWpx_BOAT_IDLE_MINUTES);
  const idleMinutes = /^\d{1,3}$/.test(idleText) ? Number(idleText) : NaN;
  if (!Number.isInteger(idleMinutes) || idleMinutes < 5 || idleMinutes > 240) {
    throw new Error('boat idle minutes must be an integer from 5 to 240');
  }
  const user = String(raw.RAUHWpx_BOAT_USER ?? 'user');
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(user) || user === 'root') throw new Error('boat SSH user is invalid');
  return Object.freeze({
    kind,
    sandboxId,
    idleMinutes,
    user,
    assignments: Object.freeze([
      'RAUHWpx_HOST_KIND=boat',
      `RAUHWpx_BOAT_SANDBOX_ID=${sandboxId}`,
      `RAUHWpx_BOAT_IDLE_MINUTES=${idleMinutes}`,
      `RAUHWpx_BOAT_USER=${user}`,
    ]),
  });
}

/** 이미 설치된 서비스를 재사용하려면 boat 유휴 설정도 같아야 한다. 다르면 설치를 다시 돌린다. */
function boatConfigProbe(hostEnv, envFile = BOAT_ENV_FILE) {
  if (hostEnv?.kind !== 'boat') return [];
  const value = (name) => `"$(sudo -n sed -n -E "s/^(RAUHWpx_)?${name}=[\\"']?([^\\"']*)[\\"']?\\$/\\2/p" '${envFile}' | tail -1)"`;
  return [
    `sudo -n test -f '${envFile}' || exit 0`,
    `[ ${value('BOAT_SANDBOX_ID')} = ${hostEnv.sandboxId} ] || exit 0`,
    `[ ${value('BOAT_IDLE_MINUTES')} = ${hostEnv.idleMinutes} ] || exit 0`,
    `[ ${value('BOAT_USER')} = ${hostEnv.user} ] || exit 0`,
    'sudo -n systemctl is-enabled --quiet rauhwpx-boat-idle.timer || exit 0',
  ];
}

function installRemoteCommand({ channel, transport, publicHost, tailscaleHttpsPort, hostEnv = NO_HOST_ENV }) {
  return [
    'sudo -n env',
    `RAUHWpx_CHANNEL=${channel}`,
    `RAUHWpx_TRANSPORT=${transport}`,
    ...(transport === 'tailscale' ? [`RAUHWpx_TAILSCALE_HTTPS_PORT=${tailscaleHttpsPort}`] : []),
    ...(transport === 'public-https' ? [`RAUHWpx_PUBLIC_HOST=${publicHost}`] : []),
    ...hostEnv.assignments,
    'bash -s',
  ].join(' ');
}

function bootstrapArchitecture(machineArchitecture) {
  if (machineArchitecture === 'x86_64') return 'amd64';
  if (machineArchitecture === 'aarch64' || machineArchitecture === 'arm64') return 'arm64';
  throw new Error('VPS architecture must be amd64 or arm64');
}

function bundledInstallRemoteCommand({
  channel,
  transport,
  publicHost,
  tailscaleHttpsPort,
  assetArchitecture,
  hostEnv = NO_HOST_ENV,
  devUnsignedSha256 = '',
}) {
  if (devUnsignedSha256 && !DEV_SHA256_RE.test(devUnsignedSha256)) {
    throw new Error('Development Cloud runtime SHA-256 is invalid');
  }
  const archive = `rauhwpx-cloud-linux-${assetArchitecture}.tar.gz`;
  const install = [
    'sudo -n env',
    `RAUHWpx_CHANNEL=${channel}`,
    `RAUHWpx_TRANSPORT=${transport}`,
    ...(transport === 'tailscale' ? [`RAUHWpx_TAILSCALE_HTTPS_PORT=${tailscaleHttpsPort}`] : []),
    ...(transport === 'public-https' ? [`RAUHWpx_PUBLIC_HOST=${publicHost}`] : []),
    ...hostEnv.assignments,
    ...(devUnsignedSha256 ? [`RAUHWpx_DEV_UNSIGNED_SHA256=${devUnsignedSha256}`] : []),
    `RAUHWpx_RELEASE_URL=file://$TMP/${archive}`,
    'bash "$TMP/install.sh"',
  ].join(' ');
  return [
    'set -eu',
    'TMP=$(mktemp -d)',
    'trap \'rm -rf "$TMP"\' EXIT HUP INT TERM',
    'tar -xzf - -C "$TMP"',
    `test -f "$TMP/${archive}"`,
    `test -f "$TMP/${archive}.sha256"`,
    ...(devUnsignedSha256 ? [] : [`test -f "$TMP/${archive}.sigstore.json"`]),
    'test -f "$TMP/install.sh"',
    install,
  ].join('; ');
}

function receiptCacheCommands(platform, requestId) {
  const normalized = String(requestId ?? randomBytes(16).toString('hex'));
  if (!/^[a-f0-9]{32}$/.test(normalized)) throw new Error('Provision receipt request id is invalid');
  const directory = platform === 'darwin'
    ? '/Library/Application Support/Rauhwpx Cloud/provision-receipts'
    : '/var/lib/rauhwpx-cloud/provision-receipts';
  return {
    before: [
      `RECEIPT_DIR='${directory}'`,
      'sudo -n install -d -m 0700 "$RECEIPT_DIR"',
      'sudo -n find "$RECEIPT_DIR" -type f -name \'*.receipt\' -mmin +15 -delete >/dev/null 2>&1 || true',
      `RECEIPT_FILE="$RECEIPT_DIR/${normalized}.receipt"`,
      'if sudo -n test -s "$RECEIPT_FILE"; then sudo -n cat "$RECEIPT_FILE"; exit 0; fi',
    ],
    after: [
      'RECEIPT_LINE="RAUHWpx_RECEIPT=$RECEIPT"',
      'printf "%s\\n" "$RECEIPT_LINE" | sudo -n sh -c \'umask 077; cat >"$1"\' sh "$RECEIPT_FILE.tmp"',
      'sudo -n mv -f "$RECEIPT_FILE.tmp" "$RECEIPT_FILE"',
      'sudo -n cat "$RECEIPT_FILE"',
    ],
  };
}

function existingInstallRemoteCommand({
  transport,
  publicHost,
  tailscaleHttpsPort,
  requiredVersion = '',
  requestId,
  hostEnv = NO_HOST_ENV,
}) {
  const receiptCache = receiptCacheCommands('linux', requestId);
  const endpoint = transport === 'tailscale'
    ? [
        `EXISTING_PORT=$(sudo -n sed -n 's/^RAUHWpx_TAILSCALE_HTTPS_PORT=//p' /etc/rauhwpx-cloud.env | tail -1) || exit 0`,
        `[ "$EXISTING_PORT" = "${tailscaleHttpsPort}" ] || exit 0`,
        'TAILSCALE_JSON=$(sudo -n tailscale status --json) || exit 0',
        `DNS_NAME=$(sudo -n /opt/rauhwpx-node/bin/node -e 'const s=JSON.parse(process.argv[1]); process.stdout.write(String(s.Self?.DNSName||"").replace(/\\.$/,""))' "$TAILSCALE_JSON") || exit 0`,
        '[ -n "$DNS_NAME" ] || exit 0',
        `PORT_SUFFIX=; [ "${tailscaleHttpsPort}" = 443 ] || PORT_SUFFIX=:${tailscaleHttpsPort}`,
        'ENDPOINT="https://${DNS_NAME}${PORT_SUFFIX}/rauhwpx-cloud"',
        `RECEIPT_PORT=${tailscaleHttpsPort}`,
      ]
    : transport === 'ssh-tunnel'
      ? [
        'ENDPOINT=http://127.0.0.1:7740/rauhwpx-cloud',
        'RECEIPT_PORT=',
      ]
      : [
        `sudo -n grep -Fqx '${publicHost} {' /etc/caddy/Caddyfile.d/rauhwpx-cloud.caddy || exit 0`,
        `ENDPOINT=https://${publicHost}/rauhwpx-cloud`,
        'RECEIPT_PORT=',
      ];
  return [
    'set -eu',
    'sudo -n systemctl is-active --quiet rauhwpx-cloud.service || exit 0',
    'sudo -n test -x /usr/local/bin/rauhwpx-cloud || exit 0',
    `EXISTING_BASE=$(sudo -n sed -n 's/^RAUHWpx_BASE_PATH=//p' /etc/rauhwpx-cloud.env | tail -1) || exit 0`,
    '[ "$EXISTING_BASE" = /rauhwpx-cloud ] || exit 0',
    `EXISTING_PROTOCOL=$(sudo -n /opt/rauhwpx-node/bin/node -e 'import("/opt/rauhwpx-cloud/current/src/protocol.mjs").then((m)=>process.stdout.write(String(m.PROTOCOL_VERSION)))') || exit 0`,
    `[ "$EXISTING_PROTOCOL" = ${EXPECTED_CLOUD_PROTOCOL} ] || exit 0`,
    ...(requiredVersion ? [
      `EXISTING_VERSION=$(sudo -n /opt/rauhwpx-node/bin/node -p 'require("/opt/rauhwpx-cloud/current/package.json").version') || exit 0`,
      `[ "$EXISTING_VERSION" = "${requiredVersion}" ] || exit 0`,
    ] : []),
    'sudo -n curl --fail --silent http://127.0.0.1:7740/v1/health >/dev/null || exit 0',
    ...boatConfigProbe(hostEnv),
    ...endpoint,
    'sudo -n curl --fail --silent --connect-timeout 10 "$ENDPOINT/v1/health" >/dev/null || exit 0',
    ...receiptCache.before,
    'PAIRING_JSON=$(sudo -n /usr/local/bin/rauhwpx-cloud pairing create "Origin device")',
    `RECEIPT=$(sudo -n /opt/rauhwpx-node/bin/node -e '
      const pairing=JSON.parse(process.argv[1]);
      const receipt={endpoint:process.argv[2],serverPublicKey:pairing.serverPublicKey,pairingCode:pairing.code,transport:process.argv[4]};
      if(process.argv[3]) receipt.tailscaleHttpsPort=Number(process.argv[3]);
      process.stdout.write(JSON.stringify(receipt));
    ' "$PAIRING_JSON" "$ENDPOINT" "$RECEIPT_PORT" "${transport}")`,
    ...receiptCache.after,
  ].join('; ');
}

function existingMacosInstallRemoteCommand({ requiredVersion = '', requestId } = {}) {
  const receiptCache = receiptCacheCommands('darwin', requestId);
  return [
    'set -eu',
    'sudo -n launchctl print system/com.hataewook.rauhwpx-cloud >/dev/null 2>&1 || exit 0',
    'sudo -n test -x /usr/local/bin/rauhwpx-cloud || exit 0',
    `EXISTING_BASE=$(sudo -n sed -n 's/^RAUHWpx_BASE_PATH=//p' '/Library/Application Support/Rauhwpx Cloud/cloud.env' | tail -1) || exit 0`,
    '[ "$EXISTING_BASE" = /rauhwpx-cloud ] || exit 0',
    `EXISTING_HOST=$(sudo -n sed -n 's/^RAUHWpx_HOST=//p' '/Library/Application Support/Rauhwpx Cloud/cloud.env' | tail -1) || exit 0`,
    '[ "$EXISTING_HOST" = 127.0.0.1 ] || exit 0',
    `EXISTING_PORT=$(sudo -n sed -n 's/^RAUHWpx_PORT=//p' '/Library/Application Support/Rauhwpx Cloud/cloud.env' | tail -1) || exit 0`,
    '[ "$EXISTING_PORT" = 7740 ] || exit 0',
    'sudo -n test -x /opt/homebrew/opt/node@24/bin/node || exit 0',
    `EXISTING_PROTOCOL=$(sudo -n /opt/homebrew/opt/node@24/bin/node -e 'import("/Library/Application Support/Rauhwpx Cloud/current/src/protocol.mjs").then((m)=>process.stdout.write(String(m.PROTOCOL_VERSION)))') || exit 0`,
    `[ "$EXISTING_PROTOCOL" = ${EXPECTED_CLOUD_PROTOCOL} ] || exit 0`,
    ...(requiredVersion ? [
      `EXISTING_VERSION=$(sudo -n /opt/homebrew/opt/node@24/bin/node -p 'require("/Library/Application Support/Rauhwpx Cloud/current/package.json").version') || exit 0`,
      `[ "$EXISTING_VERSION" = "${requiredVersion}" ] || exit 0`,
    ] : []),
    'sudo -n curl --fail --silent --connect-timeout 10 http://127.0.0.1:7740/v1/health >/dev/null || exit 0',
    ...receiptCache.before,
    'PAIRING_JSON=$(sudo -n /usr/local/bin/rauhwpx-cloud pairing create "Origin device")',
    `RECEIPT=$(sudo -n /opt/homebrew/opt/node@24/bin/node -e '
      const pairing=JSON.parse(process.argv[1]);
      process.stdout.write(JSON.stringify({
        endpoint:"http://127.0.0.1:7740/rauhwpx-cloud",
        serverPublicKey:pairing.serverPublicKey,
        pairingCode:pairing.code,
        transport:"ssh-tunnel"
      }));
    ' "$PAIRING_JSON")`,
    ...receiptCache.after,
  ].join('; ');
}

const SCANNED_KEY_TYPES = new Set(['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'ssh-rsa']);

/** ssh-keyscan 출력에서 키와 OpenSSH 식 SHA256 지문을 뽑는다. */
function parseScannedHostKeys(text) {
  const keys = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const [, type, key] = line.trim().split(/\s+/);
    if (line.startsWith('#') || !SCANNED_KEY_TYPES.has(type) || !/^[A-Za-z0-9+/]+={0,2}$/.test(key ?? '')) continue;
    const digest = createHash('sha256').update(Buffer.from(key, 'base64')).digest('base64').replace(/=+$/, '');
    if (!keys.some((entry) => entry.key === key)) keys.push({ type, key, fingerprint: `SHA256:${digest}` });
  }
  return keys;
}

export function sshArguments(sshConfig, knownHostsPath, remoteCommand, { acceptNew = false } = {}) {
  const ssh = normalizeSshConfig(sshConfig);
  return [
    '-o', 'BatchMode=yes',
    '-o', 'PasswordAuthentication=no',
    '-o', 'KbdInteractiveAuthentication=no',
    '-o', 'ConnectTimeout=12',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', sshOptionFilePath('UserKnownHostsFile', knownHostsPath),
    '-o', `StrictHostKeyChecking=${acceptNew ? 'accept-new' : 'yes'}`,
    '-p', String(ssh.port),
    ...(ssh.keyPath ? ['-i', ssh.keyPath, '-o', 'IdentitiesOnly=yes'] : []),
    sshDestination(ssh),
    remoteCommand,
  ];
}

function invalidProvisionReceipt(message) {
  return Object.assign(new Error(message), { code: 'PROVISION_RECEIPT_INVALID' });
}

function parseProvisionReceipt(stdout) {
  const line = stdout.split(/\r?\n/).findLast((candidate) => candidate.startsWith('RAUHWpx_RECEIPT='));
  if (!line) throw invalidProvisionReceipt('VPS installer did not return a provisioning receipt');
  let receipt;
  try { receipt = JSON.parse(line.slice('RAUHWpx_RECEIPT='.length)); } catch {
    throw invalidProvisionReceipt('VPS installer returned an invalid provisioning receipt');
  }
  if (!/^ed25519:[A-Za-z0-9_-]{59}$/.test(String(receipt.serverPublicKey ?? ''))) {
    throw invalidProvisionReceipt('VPS installer did not return a valid server identity');
  }
  let endpoint;
  try { endpoint = new URL(receipt.endpoint); } catch {
    throw invalidProvisionReceipt('VPS installer did not return a secure endpoint');
  }
  const loopbackTunnel = receipt.transport === 'ssh-tunnel'
    && endpoint.protocol === 'http:'
    && endpoint.hostname === '127.0.0.1'
    && Number(endpoint.port) === 7740;
  if ((!loopbackTunnel && endpoint.protocol !== 'https:') || endpoint.username || endpoint.password) {
    throw invalidProvisionReceipt('VPS installer did not return a secure endpoint');
  }
  if (receipt.tailscaleHttpsPort !== undefined) {
    if (typeof receipt.tailscaleHttpsPort !== 'number') {
      throw invalidProvisionReceipt('VPS installer returned an invalid Tailscale HTTPS port');
    }
    let port;
    try { port = normalizeTailscaleHttpsPort(receipt.tailscaleHttpsPort); } catch {
      throw invalidProvisionReceipt('VPS installer returned an invalid Tailscale HTTPS port');
    }
    if (Number(endpoint.port || 443) !== port) {
      throw invalidProvisionReceipt('VPS installer endpoint does not match its Tailscale HTTPS port');
    }
  }
  if (receipt.pairingCode != null && !/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(receipt.pairingCode)) {
    throw invalidProvisionReceipt('VPS installer returned an invalid pairing code');
  }
  return receipt;
}

export class CloudProvisioner {
  constructor({
    spawnImpl = nodeSpawn,
    installerPath,
    bootstrapDir = '',
    appVersion = '',
    knownHostsPath,
    retrySleep = (ms) => delay(ms),
    devUnsignedRuntime = false,
  }) {
    if (!installerPath) throw new Error('CloudProvisioner requires an installer path');
    if (!knownHostsPath) throw new Error('CloudProvisioner requires a known-hosts path');
    this.spawn = spawnImpl;
    this.installerPath = installerPath;
    this.bootstrapDir = bootstrapDir;
    this.appVersion = appVersion;
    this.knownHostsPath = knownHostsPath;
    this.retrySleep = retrySleep;
    // 패키징하지 않은 개발 앱만 켠다. 서명 번들 대신 옆에 둔 .dev-sha256 값으로 런타임을 고정한다.
    this.devUnsignedRuntime = devUnsignedRuntime === true;
  }

  async #bootstrap(machineArchitecture) {
    if (!this.bootstrapDir) return null;
    const assetArchitecture = bootstrapArchitecture(machineArchitecture);
    const filename = path.join(
      this.bootstrapDir,
      `rauhwpx-cloud-bootstrap-linux-${assetArchitecture}.tar.gz`,
    );
    const stat = await fs.stat(filename).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) return null;
    if (!stat.isFile() || stat.size < 1 || stat.size > BOOTSTRAP_LIMIT) {
      throw new Error('Bundled Cloud runtime is invalid');
    }
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(this.appVersion)) {
      throw new Error('Bundled Cloud runtime requires a valid app version');
    }
    let devUnsignedSha256 = '';
    if (this.devUnsignedRuntime) {
      const pin = await fs.readFile(`${filename}.dev-sha256`, 'utf8').catch((error) => {
        if (error?.code === 'ENOENT') return '';
        throw error;
      });
      devUnsignedSha256 = pin.trim();
      if (devUnsignedSha256 && !DEV_SHA256_RE.test(devUnsignedSha256)) {
        throw new Error('Development Cloud runtime SHA-256 is invalid');
      }
    }
    return { assetArchitecture, devUnsignedSha256, bytes: await fs.readFile(filename) };
  }

  async #reuseExisting(ssh, options, onLine) {
    const remote = options.platform === 'darwin'
      ? existingMacosInstallRemoteCommand(options)
      : existingInstallRemoteCommand(options);
    const result = await retryTransientSsh(() => runProcess(
      this.spawn,
      'ssh',
      sshArguments(ssh, this.knownHostsPath, remote),
      { timeoutMs: 30_000, onLine },
    ), { onLine, sleep: this.retrySleep });
    if (!result.stdout.split(/\r?\n/).some((line) => line.startsWith('RAUHWpx_RECEIPT='))) return null;
    onLine('Using the compatible Cloud service already installed on this VPS');
    return parseProvisionReceipt(result.stdout);
  }

  async #installWithRecovery(ssh, options, preflight, onLine, install) {
    let failure;
    try {
      const result = await install();
      return { ...parseProvisionReceipt(result.stdout), preflight };
    } catch (error) {
      if (!transientSshFailure(error) && error?.code !== 'PROVISION_RECEIPT_INVALID') throw error;
      failure = error;
    }

    onLine('The installer response was interrupted; checking the installed Cloud service');
    const recovered = await this.#reuseExisting(ssh, {
      ...options,
      platform: preflight.platform,
    }, onLine);
    if (!recovered) throw failure;
    onLine('Recovered the Cloud installation after the interrupted installer response');
    return { ...recovered, preflight, recovered: true };
  }

  /**
   * 처음 접속하는 VPS는 호스트 키를 처음 본 대로 받는다. boat VM은 호스트 키를 미리 핀하므로
   * `strictHostKey`로 핀된 키만 받는다.
   */
  async preflight(sshConfig, { onLine = () => {}, strictHostKey = false } = {}) {
    const ssh = normalizeSshConfig(sshConfig);
    await fs.mkdir(path.dirname(this.knownHostsPath), { recursive: true, mode: 0o700 });
    const remote = [
      'set -eu',
      'printf "arch=%s\\n" "$(uname -m)"',
      'if [ "$(uname -s)" = Darwin ]; then printf "os=macos version=%s\\n" "$(sw_vers -productVersion)"; else . /etc/os-release; printf "os=%s version=%s\\n" "$ID" "$VERSION_ID"; fi',
      'command -v sudo >/dev/null',
      'sudo -n true',
      ...(ssh.useTailscaleSsh ? ['command -v tailscale >/dev/null', 'tailscale status --json >/dev/null'] : []),
      'printf "preflight=ok\\n"',
    ].join('; ');
    const result = await retryTransientSsh(() => runProcess(
      this.spawn,
      'ssh',
      sshArguments(ssh, this.knownHostsPath, remote, { acceptNew: !strictHostKey }),
      { timeoutMs: 25_000, onLine },
    ), { onLine, sleep: this.retrySleep });
    const output = `${result.stdout}\n${result.stderr}`;
    if (!output.includes('preflight=ok')) throw new Error('VPS preflight did not complete');
    const os = output.match(/os=([^\s]+) version=([^\s]+)/);
    const arch = output.match(/arch=([^\s]+)/);
    if (!os || !['ubuntu', 'debian', 'macos'].includes(os[1])) throw new Error('Remote host must run macOS, Ubuntu, or Debian');
    if (!arch || !['x86_64', 'aarch64', 'arm64'].includes(arch[1])) {
      throw new Error('VPS architecture must be amd64 or arm64');
    }
    if (os[1] === 'macos' && arch[1] !== 'arm64') throw new Error('Mac Cloud hosts require Apple silicon');
    if (os[1] === 'macos' && Number(os[2].split('.')[0]) < 14) throw new Error('Mac Cloud hosts require macOS 14 or newer');
    return { platform: os[1] === 'macos' ? 'darwin' : 'linux', os: os[1], version: os[2], arch: arch[1] };
  }

  async provision(sshConfig, {
    channel = 'stable',
    transport = 'tailscale',
    tailscaleHttpsPort = 443,
    publicHost = '',
    hostEnv: rawHostEnv = null,
    onLine = () => {},
  } = {}) {
    if (!CHANNELS.has(channel)) throw new Error('Unsupported cloud install channel');
    if (!['tailscale', 'public-https', 'ssh-tunnel'].includes(transport)) throw new Error('Unsupported cloud transport');
    const hostEnv = normalizeHostEnv(rawHostEnv, { transport });
    const servePort = transport === 'tailscale'
      ? normalizeTailscaleHttpsPort(tailscaleHttpsPort)
      : 443;
    if (transport === 'public-https' && !/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])$/.test(publicHost)) {
      throw new Error('Public HTTPS provisioning requires a valid DNS hostname');
    }
    const ssh = normalizeSshConfig(sshConfig);
    const preflight = await this.preflight(ssh, { onLine, strictHostKey: hostEnv.kind === 'boat' });
    const bootstrap = preflight.platform === 'linux' ? await this.#bootstrap(preflight.arch) : null;
    if (preflight.platform === 'darwin' && transport !== 'ssh-tunnel') {
      throw new Error('Mac Cloud hosts require the SSH tunnel transport');
    }
    if (preflight.platform === 'darwin' && hostEnv.kind) {
      throw new Error('boat Cloud hosts must run Linux');
    }
    if (preflight.platform === 'darwin') {
      const existing = await this.#reuseExisting(ssh, {
        platform: 'darwin',
        transport,
        publicHost,
        tailscaleHttpsPort: servePort,
      }, onLine);
      if (existing) return { ...existing, preflight, reused: true };
      const installerPath = path.join(path.dirname(this.installerPath), 'install-macos.sh');
      const installer = await fs.readFile(installerPath);
      const remote = installRemoteCommand({
        channel,
        transport,
        publicHost,
        tailscaleHttpsPort: servePort,
      });
      return this.#installWithRecovery(ssh, {
        transport,
        publicHost,
        tailscaleHttpsPort: servePort,
      }, preflight, onLine, () => runProcess(
        this.spawn,
        'ssh',
        sshArguments(ssh, this.knownHostsPath, remote),
        { input: installer, timeoutMs: INSTALL_TIMEOUT_MS, onLine },
      ));
    }
    const existing = await this.#reuseExisting(ssh, {
      transport,
      publicHost,
      tailscaleHttpsPort: servePort,
      requiredVersion: bootstrap ? this.appVersion : '',
      hostEnv,
    }, onLine);
    if (existing) return { ...existing, preflight, reused: true };
    if (bootstrap) {
      onLine(bootstrap.devUnsignedSha256
        ? 'Using the local development Cloud runtime'
        : 'Using the verified Cloud runtime bundled with Rauhwpx');
      const remote = bundledInstallRemoteCommand({
        channel,
        transport,
        publicHost,
        tailscaleHttpsPort: servePort,
        assetArchitecture: bootstrap.assetArchitecture,
        hostEnv,
        devUnsignedSha256: bootstrap.devUnsignedSha256,
      });
      return this.#installWithRecovery(ssh, {
        transport,
        publicHost,
        tailscaleHttpsPort: servePort,
        requiredVersion: this.appVersion,
        hostEnv,
      }, preflight, onLine, () => runProcess(
        this.spawn,
        'ssh',
        sshArguments(ssh, this.knownHostsPath, remote),
        { input: bootstrap.bytes, timeoutMs: INSTALL_TIMEOUT_MS, onLine },
      ));
    }
    const installer = await fs.readFile(this.installerPath);
    if (!installer.length || installer.length > 2 * 1024 * 1024) throw new Error('Cloud installer is missing or invalid');
    const remote = installRemoteCommand({
      channel,
      transport,
      publicHost,
      tailscaleHttpsPort: servePort,
      hostEnv,
    });
    return this.#installWithRecovery(ssh, {
      transport,
      publicHost,
      tailscaleHttpsPort: servePort,
      hostEnv,
    }, preflight, onLine, () => runProcess(
      this.spawn,
      'ssh',
      sshArguments(ssh, this.knownHostsPath, remote),
      { input: installer, timeoutMs: INSTALL_TIMEOUT_MS, onLine },
    ));
  }

  /** 설치 스크립트가 등록한 서비스를 다시 시작한다. Mac 호스트는 launchd, Linux 는 systemd 다. */
  async restartService(sshConfig) {
    const ssh = normalizeSshConfig(sshConfig);
    const remote = [
      'set -eu',
      'if [ "$(uname -s)" = Darwin ]; then sudo -n launchctl kickstart -k system/com.hataewook.rauhwpx-cloud;',
      'else sudo -n systemctl restart rauhwpx-cloud.service; fi',
    ].join(' ');
    await retryTransientSsh(() => runProcess(
      this.spawn,
      'ssh',
      sshArguments(ssh, this.knownHostsPath, remote),
      { timeoutMs: 120_000 },
    ), { sleep: this.retrySleep });
  }

  /**
   * 서버가 지금 내미는 호스트 키를 읽는다. 저장된 키와 다를 때 사용자에게 보일 지문을 만든다.
   * 이 결과만으로는 아무것도 믿지 않는다. trustHostKey 가 같은 지문을 다시 확인한 뒤에만 저장한다.
   */
  async scanHostKey(sshConfig) {
    const ssh = normalizeSshConfig(sshConfig);
    const result = await runProcess(
      this.spawn,
      'ssh-keyscan',
      ['-T', '10', '-p', String(ssh.port), ssh.host],
      { timeoutMs: 20_000 },
    );
    const keys = parseScannedHostKeys(result.stdout);
    if (!keys.length) throw Object.assign(new Error('The server did not present an SSH host key'), { code: 'SSH_HOST_KEY_UNAVAILABLE' });
    const preferred = keys.find((entry) => entry.type === 'ssh-ed25519') ?? keys[0];
    return { host: ssh.host, port: ssh.port, fingerprint: preferred.fingerprint, keys };
  }

  /** 사용자가 확인한 지문이 여전히 서버의 키일 때만 그 주소의 옛 핀을 지우고 새 키를 저장한다. */
  async trustHostKey(sshConfig, fingerprint) {
    const scanned = await this.scanHostKey(sshConfig);
    if (!scanned.keys.some((entry) => entry.fingerprint === fingerprint)) {
      throw Object.assign(new Error('The SSH host key changed again before it was confirmed'), { code: 'SSH_HOST_KEY_MISMATCH' });
    }
    const pattern = scanned.port === 22 ? scanned.host : `[${scanned.host}]:${scanned.port}`;
    await fs.mkdir(path.dirname(this.knownHostsPath), { recursive: true, mode: 0o700 });
    // ssh-keygen -R 은 해시된 줄도 지운다. 파일이 없거나 줄이 없으면 실패해도 괜찮다.
    await runProcess(this.spawn, 'ssh-keygen', ['-R', pattern, '-f', this.knownHostsPath], { timeoutMs: 10_000 })
      .catch(() => {});
    await fs.rm(`${this.knownHostsPath}.old`, { force: true }).catch(() => {});
    const lines = scanned.keys.map((entry) => `${pattern} ${entry.type} ${entry.key}`).join('\n');
    await fs.appendFile(this.knownHostsPath, `${lines}\n`, { mode: 0o600 });
    return { fingerprint };
  }

  async verify(sshConfig, { onLine = () => {} } = {}) {
    const ssh = normalizeSshConfig(sshConfig);
    const remote = [
      'set -eu',
      'sudo -n systemctl is-active rauhwpx-cloud.service',
      'sudo -n systemctl is-enabled rauhwpx-cloud.service',
      'sudo -n /usr/local/lib/rauhwpx-cloud/current/bin/rauhwpx-cloud doctor --json',
    ].join('; ');
    const result = await runProcess(
      this.spawn,
      'ssh',
      sshArguments(ssh, this.knownHostsPath, remote),
      { timeoutMs: 60_000, onLine },
    );
    const jsonLine = result.stdout.split(/\r?\n/).findLast((line) => line.trim().startsWith('{'));
    if (!jsonLine) throw new Error('Cloud doctor did not return JSON');
    const doctor = JSON.parse(jsonLine);
    if (doctor.ok !== true) throw new Error('Cloud doctor reported an unhealthy service');
    return doctor;
  }
}

export const __test = {
  boatConfigProbe,
  parseScannedHostKeys,
  bootstrapArchitecture,
  bundledInstallRemoteCommand,
  existingInstallRemoteCommand,
  existingMacosInstallRemoteCommand,
  installRemoteCommand,
  parseProvisionReceipt,
  retryTransientSsh,
  runProcess,
  transientSshFailure,
};
