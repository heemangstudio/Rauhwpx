import path from 'node:path';

export const DEFAULT_PORT = 5180;
export const RAILWAY_DATA_DIR = '/data';

/** Railway 볼륨은 /data. 로컬은 현재 디렉터리. */
export function resolveDataDir(env = process.env) {
  const explicit = typeof env.RAU_SITE_DATA === 'string' ? env.RAU_SITE_DATA.trim() : '';
  if (explicit) return explicit;
  return env.RAILWAY_ENVIRONMENT ? RAILWAY_DATA_DIR : '.';
}

export function resolveUniqueInstallsDbPath(env = process.env) {
  return path.join(resolveDataDir(env), 'unique-installs.json');
}

export function resolveWaitlistDbPath(env = process.env) {
  return path.join(resolveDataDir(env), 'waitlist.json');
}

export function resolveUniqueInstallPingKey(env = process.env) {
  return typeof env.RAU_UNIQUE_INSTALL_PING_KEY === 'string'
    ? env.RAU_UNIQUE_INSTALL_PING_KEY.trim()
    : '';
}

export function resolveLicensesDbPath(env = process.env) {
  return path.join(resolveDataDir(env), 'licenses.json');
}

export const DEFAULT_LICENSE_ALLOWED_ORIGINS = [
  'https://heemangstudios.com',
  'https://www.heemangstudios.com',
  'https://heemangstudio.github.io',
];

function trimmed(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** License settings from env. Parsing errors throw at startup so a typo never ships silently. */
export function resolveLicenseConfig(env = process.env) {
  const origins = trimmed(env.LICENSE_ALLOWED_ORIGINS);
  const cutoffText = trimmed(env.GRANDFATHER_CUTOFF);
  let grandfatherCutoff;
  if (cutoffText) {
    grandfatherCutoff = Date.parse(cutoffText);
    if (!Number.isFinite(grandfatherCutoff)) {
      throw new Error(`GRANDFATHER_CUTOFF is not an ISO-8601 time: ${cutoffText}`);
    }
  }
  const price = Number(trimmed(env.GROBLE_EXPECTED_PRICE) || 9900);
  const minAmount = Number(trimmed(env.GROBLE_MIN_AMOUNT) || price);
  if (!Number.isSafeInteger(price) || !Number.isSafeInteger(minAmount)) {
    throw new Error('GROBLE_EXPECTED_PRICE and GROBLE_MIN_AMOUNT must be integers (KRW)');
  }
  return {
    webhookSecret: trimmed(env.GROBLE_WEBHOOK_SECRET),
    webhookSecretPrevious: trimmed(env.GROBLE_WEBHOOK_SECRET_PREVIOUS),
    grobleContentId: trimmed(env.GROBLE_CONTENT_ID) || 'uRshdR',
    expectedPrice: price,
    minAmount,
    signingPrivateKey: trimmed(env.LICENSE_SIGNING_PRIVATE_KEY),
    adminToken: trimmed(env.ADMIN_TOKEN),
    grandfatherCutoff,
    grandfatherPlatforms: (trimmed(env.GRANDFATHER_PLATFORMS) || 'darwin').split(',').map((s) => s.trim()).filter(Boolean),
    allowedOrigins: origins ? origins.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_LICENSE_ALLOWED_ORIGINS,
    downloadUrl: trimmed(env.LICENSE_DOWNLOAD_URL) || 'https://heemangstudios.com/',
  };
}
