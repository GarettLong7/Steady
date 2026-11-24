import { argon2, createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const argon = promisify(argon2);
const parameters = { memory: 65536, passes: 3, parallelism: 1, tagLength: 32 };
export const token = () => randomBytes(32).toString('hex');

async function derive(password, salt, purpose) {
  const message = Buffer.from(password);
  try {
    return await argon('argon2id', { ...parameters, message, nonce: salt, associatedData: Buffer.from(purpose) });
  } finally {
    message.fill(0);
  }
}

export function seal(key, value, context) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64');
}

export function unseal(key, value, context) {
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length < 28 || bytes.toString('base64') !== value) throw new Error('Invalid ciphertext');
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12), { authTagLength: 16 });
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(bytes.subarray(12, 28));
  const prefix = decipher.update(bytes.subarray(28));
  try {
    return Buffer.concat([prefix, decipher.final()]);
  } finally {
    prefix.fill(0);
  }
}

export async function credentials(password, dek) {
  const salt = randomBytes(16);
  const wrapSalt = randomBytes(16);
  const hash = await derive(password, salt, 'steady/auth/v1');
  try {
    const key = await derive(password, wrapSalt, 'steady/wrap/v1');
    try {
      return { salt: salt.toString('hex'), hash: hash.toString('hex'), wrapSalt: wrapSalt.toString('hex'),
        wrapped: seal(key, dek, 'steady/dek/v1') };
    } finally {
      key.fill(0);
    }
  } finally {
    hash.fill(0);
  }
}

export async function unlock(password, stored) {
  const candidate = await derive(password, Buffer.from(stored.salt, 'hex'), 'steady/auth/v1');
  try {
    if (!timingSafeEqual(candidate, Buffer.from(stored.hash, 'hex'))) return null;
  } finally {
    candidate.fill(0);
  }
  const key = await derive(password, Buffer.from(stored.wrapSalt, 'hex'), 'steady/wrap/v1');
  try {
    return unseal(key, stored.wrapped, 'steady/dek/v1');
  } finally {
    key.fill(0);
  }
}

export async function encryptBackup(password, data) {
  const salt = randomBytes(16);
  const key = await derive(password, salt, 'steady/backup/v1');
  const bytes = Buffer.from(JSON.stringify(data));
  try {
    return { format: 'steady-backup-v1', salt: salt.toString('hex'), data: seal(key, bytes, 'steady/backup/v1') };
  } finally {
    key.fill(0);
    bytes.fill(0);
  }
}

export async function decryptBackup(password, envelope) {
  if (envelope?.format !== 'steady-backup-v1' || typeof envelope.salt !== 'string' ||
      !/^[a-f0-9]{32}$/.test(envelope.salt) || typeof envelope.data !== 'string') throw new Error('Invalid backup');
  const key = await derive(password, Buffer.from(envelope.salt, 'hex'), 'steady/backup/v1');
  try {
    const bytes = unseal(key, envelope.data, 'steady/backup/v1');
    try {
      return JSON.parse(bytes.toString());
    } finally {
      bytes.fill(0);
    }
  } finally {
    key.fill(0);
  }
}

