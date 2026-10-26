import { randomBytes, randomUUID, scrypt as scryptCallback, createHash, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { del, get as getBlob } from '@vercel/blob';
import { handleUpload } from '@vercel/blob/client';
import { all, get, query, run } from './database.mjs';

const scrypt = promisify(scryptCallback);
const maxPhotos = 999;
const maxImageBytes = 25 * 1024 * 1024;
const sessionTtl = 30 * 24 * 60 * 60;
const recoveryAttempts = new Map();
const secureCookie = process.env.COOKIE_SECURE === 'true' ||
  (process.env.COOKIE_SECURE !== 'false' && process.env.NODE_ENV === 'production');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(status, value, headers = {}) {
  return Response.json(value, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers },
  });
}

async function readJson(request, limit = 128 * 1024) {
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > limit) throw new HttpError(413, '请求数据过大');
  try {
    return JSON.parse(body);
  } catch {
    throw new HttpError(400, '请求数据格式无效');
  }
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function getCookie(request, name) {
  return (request.headers.get('cookie') ?? '').split(';').map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1) ?? '';
}

function sessionCookie(token, maxAge = sessionTtl) {
  return `session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secureCookie ? '; Secure' : ''}`;
}

async function getSessionUser(request) {
  const token = getCookie(request, 'session');
  if (!/^[A-Za-z0-9_-]{40,50}$/.test(token)) return null;
  return get(`
    SELECT users.id, users.username, sessions.token_hash
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?
  `, [hashToken(token), Date.now()]);
}

async function requireUser(request) {
  const user = await getSessionUser(request);
  if (!user) throw new HttpError(401, '请先登录');
  return user;
}

async function createSession(userId) {
  const token = randomBytes(32).toString('base64url');
  await run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)',
    [hashToken(token), userId, Date.now() + sessionTtl * 1000]);
  return token;
}

async function passwordDigest(password, salt) {
  return scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

function normalizeUsername(value) {
  if (typeof value !== 'string') throw new HttpError(400, '请输入账号');
  const username = value.normalize('NFKC').trim();
  const length = Array.from(username).length;
  if (length < 3 || length > 64 || !/^[\p{L}\p{N}._@+-]+$/u.test(username)) {
    throw new HttpError(400, '账号需为 3 至 64 位字母、数字或 . _ @ + -');
  }
  return { username, key: username.toLowerCase() };
}

function normalizePhone(value) {
  if (typeof value !== 'string') throw new HttpError(400, '请输入手机号');
  const phone = value.replace(/[\s()-]/g, '');
  if (!/^\+?[1-9]\d{7,14}$/.test(phone)) throw new HttpError(400, '手机号格式无效');
  return phone.replace(/^\+/, '');
}

function maskPhone(phone) {
  if (!phone) return null;
  const start = Math.max(1, Math.floor((phone.length - 5) / 2));
  return phone.slice(0, start) + '*****' + phone.slice(start + 5);
}

function normalizeDisplayName(value) {
  if (typeof value !== 'string') throw new HttpError(400, '姓名格式无效');
  const name = value.normalize('NFC').trim();
  if (Array.from(name).length > 40 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new HttpError(400, '姓名最多 40 个字符');
  }
  return name;
}

function limitRecoveryAttempts(request, username, action, maximum) {
  const now = Date.now();
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const key = `${action}:${ip}:${username}`;
  const attempt = recoveryAttempts.get(key);
  if (attempt && attempt.expiresAt > now && attempt.count >= maximum) {
    throw new HttpError(429, '尝试次数过多，请 15 分钟后再试');
  }
  if (!attempt || attempt.expiresAt <= now) {
    recoveryAttempts.set(key, { count: 1, expiresAt: now + 15 * 60 * 1000 });
  } else {
    attempt.count += 1;
  }
  if (recoveryAttempts.size > 1000) {
    for (const [attemptKey, value] of recoveryAttempts) {
      if (value.expiresAt <= now) recoveryAttempts.delete(attemptKey);
    }
  }
}

function validatePassword(value, registration = false) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 1024) {
    throw new HttpError(400, '密码格式无效');
  }
  const length = Array.from(value).length;
  if (registration && length < 8) throw new HttpError(400, '密码至少需要 8 位');
  if (registration && length > 128) throw new HttpError(400, '密码不能超过 128 位');
  if (!value) throw new HttpError(400, '请输入密码');
  return value;
}

function normalizePhotoMetadata(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, '照片信息无效');
  const { id, name, thumbnail } = input;
  const width = Number(input.width);
  const height = Number(input.height);
  const createdAt = Number(input.createdAt);
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id) ||
      typeof name !== 'string' || !name.trim() || name.length > 255 || name.includes('\0')) {
    throw new HttpError(400, '照片信息无效');
  }
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > 100_000_000) {
    throw new HttpError(400, '照片尺寸无效');
  }
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new HttpError(400, '照片时间无效');
  if (typeof thumbnail !== 'string' || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(thumbnail) || thumbnail.length > 512 * 1024) {
    throw new HttpError(400, '照片缩略图无效');
  }
  return { id, name: name.normalize('NFC').trim(), width, height, thumbnail, createdAt };
}

function isUniqueViolation(error) {
  return error?.code === '23505' || String(error).includes('UNIQUE');
}

async function hasImageSignature(stream, mimeType) {
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (size < 12) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      size += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const header = Buffer.concat(chunks);
  if (mimeType === 'image/jpeg') return header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
  if (mimeType === 'image/png') return header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return mimeType === 'image/webp' && header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP';
}

async function handleBlobUpload(request) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) throw new HttpError(503, '尚未配置 Vercel Blob，请绑定私有 Blob 存储');
  const body = await readJson(request, 700 * 1024);
  const result = await handleUpload({
    body,
    request,
    onBeforeGenerateToken: async (pathname, clientPayload) => {
      const user = await requireUser(request);
      let input;
      try { input = JSON.parse(clientPayload ?? ''); } catch { throw new HttpError(400, '照片信息无效'); }
      const photo = normalizePhotoMetadata(input);
      if (pathname !== `photos/${user.id}/${photo.id}`) throw new HttpError(400, '上传路径无效');

      await run('DELETE FROM photo_uploads WHERE expires_at <= ?', [Date.now()]);
      const count = await get('SELECT COUNT(*) AS count FROM photos WHERE user_id = ?', [user.id]);
      const pending = await get('SELECT COUNT(*) AS count FROM photo_uploads WHERE user_id = ?', [user.id]);
      if (Number(count.count) + Number(pending.count) >= maxPhotos) {
        throw new HttpError(409, `相册最多保存 ${maxPhotos} 张照片`);
      }
      await run(`INSERT INTO photo_uploads (user_id, photo_id, name, width, height, thumbnail, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (user_id, photo_id) DO UPDATE SET expires_at = EXCLUDED.expires_at`,
      [user.id, photo.id, photo.name, photo.width, photo.height, photo.thumbnail, photo.createdAt, Date.now() + 15 * 60 * 1000]);
      return {
        allowedContentTypes: ['image/jpeg', 'image/png', 'image/webp'],
        maximumSizeInBytes: maxImageBytes,
        addRandomSuffix: false,
      };
    },
  });
  return json(200, result);
}

async function handleApiRequest(request, url) {
  const { pathname } = url;

  if (request.method === 'POST' && pathname === '/api/blob-upload') return handleBlobUpload(request);

  if (request.method === 'GET' && pathname === '/api/auth/me') {
    const user = await getSessionUser(request);
    return json(200, { user: user ? { id: user.id, username: user.username } : null });
  }

  if (request.method === 'POST' && pathname === '/api/auth/recovery-info') {
    const input = await readJson(request);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, '请求数据格式无效');
    const { key } = normalizeUsername(input.username);
    limitRecoveryAttempts(request, key, 'lookup', 10);
    const account = await get('SELECT phone_number FROM users WHERE username_key = ?', [key]);
    if (!account?.phone_number) throw new HttpError(404, '账号未绑定手机号，无法通过手机号找回');
    return json(200, { phoneMasked: maskPhone(account.phone_number) });
  }

  if (request.method === 'POST' && pathname === '/api/auth/reset-password') {
    const input = await readJson(request);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, '请求数据格式无效');
    const { key } = normalizeUsername(input.username);
    const phone = normalizePhone(input.phone);
    const password = validatePassword(input.password, true);
    limitRecoveryAttempts(request, key, 'reset', 5);
    const account = await get('SELECT id, phone_number FROM users WHERE username_key = ?', [key]);
    if (!account || account.phone_number !== phone) throw new HttpError(401, '账号或手机号不匹配');
    const salt = randomBytes(16);
    const passwordHash = await passwordDigest(password, salt);
    await run('UPDATE users SET password_salt = ?, password_hash = ? WHERE id = ?',
      [salt.toString('hex'), passwordHash.toString('hex'), account.id]);
    await run('DELETE FROM sessions WHERE user_id = ?', [account.id]);
    return json(200, { ok: true });
  }

  if (request.method === 'POST' && (pathname === '/api/auth/register' || pathname === '/api/auth/login')) {
    const input = await readJson(request);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, '请求数据格式无效');
    const { username, key } = normalizeUsername(input.username);
    const password = validatePassword(input.password, pathname.endsWith('/register'));

    if (pathname.endsWith('/register')) {
      const phone = normalizePhone(input.phone);
      if (await get('SELECT 1 FROM users WHERE username_key = ?', [key])) throw new HttpError(409, '这个账号已经注册');
      if (await get('SELECT 1 FROM users WHERE phone_number = ?', [phone])) throw new HttpError(409, '这个手机号已经绑定其他账号');
      const id = randomUUID();
      const salt = randomBytes(16);
      const passwordHash = await passwordDigest(password, salt);
      try {
        await run(`INSERT INTO users (id, username, username_key, password_salt, password_hash, phone_number, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, username, key, salt.toString('hex'), passwordHash.toString('hex'), phone, Date.now()]);
      } catch (error) {
        if (isUniqueViolation(error)) throw new HttpError(409, '账号或手机号已经注册');
        throw error;
      }
      return json(201, { user: { id, username } }, { 'Set-Cookie': sessionCookie(await createSession(id)) });
    }

    const user = await get('SELECT id, username, password_salt, password_hash FROM users WHERE username_key = ?', [key]);
    const salt = user ? Buffer.from(user.password_salt, 'hex') : Buffer.alloc(16);
    const actual = Buffer.from(await passwordDigest(password, salt));
    const expected = user ? Buffer.from(user.password_hash, 'hex') : Buffer.alloc(64);
    if (!user || !timingSafeEqual(actual, expected)) throw new HttpError(401, '账号或密码错误');
    return json(200, { user: { id: user.id, username: user.username } }, { 'Set-Cookie': sessionCookie(await createSession(user.id)) });
  }

  if (request.method === 'POST' && pathname === '/api/auth/logout') {
    const token = getCookie(request, 'session');
    if (token) await run('DELETE FROM sessions WHERE token_hash = ?', [hashToken(token)]);
    return json(200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
  }

  const user = await requireUser(request);
  if (request.method === 'PATCH' && pathname === '/api/auth/password') {
    const input = await readJson(request);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, '请求数据格式无效');
    const currentPassword = validatePassword(input.currentPassword);
    const nextPassword = validatePassword(input.newPassword, true);
    const account = await get('SELECT password_salt, password_hash FROM users WHERE id = ?', [user.id]);
    const actual = Buffer.from(await passwordDigest(currentPassword, Buffer.from(account.password_salt, 'hex')));
    if (!timingSafeEqual(actual, Buffer.from(account.password_hash, 'hex'))) throw new HttpError(401, '当前密码不正确');
    const salt = randomBytes(16);
    const passwordHash = await passwordDigest(nextPassword, salt);
    await run('UPDATE users SET password_salt = ?, password_hash = ? WHERE id = ?',
      [salt.toString('hex'), passwordHash.toString('hex'), user.id]);
    await run('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?', [user.id, user.token_hash]);
    return json(200, { ok: true });
  }

  if (request.method === 'PATCH' && pathname === '/api/account-settings/phone') {
    const input = await readJson(request);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, '请求数据格式无效');
    const phone = normalizePhone(input.phone);
    const currentPassword = validatePassword(input.currentPassword);
    const account = await get('SELECT password_salt, password_hash FROM users WHERE id = ?', [user.id]);
    const actual = Buffer.from(await passwordDigest(currentPassword, Buffer.from(account.password_salt, 'hex')));
    if (!timingSafeEqual(actual, Buffer.from(account.password_hash, 'hex'))) throw new HttpError(401, '当前密码不正确');
    try {
      await run('UPDATE users SET phone_number = ? WHERE id = ?', [phone, user.id]);
    } catch (error) {
      if (isUniqueViolation(error)) throw new HttpError(409, '这个手机号已经绑定其他账号');
      throw error;
    }
    return json(200, { phoneMasked: maskPhone(phone) });
  }

  if (request.method === 'GET' && pathname === '/api/account-settings') {
    const settings = await get('SELECT first_meeting_date AS "firstMeetingDate", person_one_name AS "personOneName", person_two_name AS "personTwoName", phone_number AS "phoneNumber" FROM users WHERE id = ?', [user.id]);
    return json(200, {
      firstMeetingDate: settings.firstMeetingDate,
      personOneName: settings.personOneName,
      personTwoName: settings.personTwoName,
      phoneMasked: maskPhone(settings.phoneNumber),
    });
  }

  if (request.method === 'PATCH' && pathname === '/api/account-settings') {
    const input = await readJson(request);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, '请求数据格式无效');
    const current = await get('SELECT first_meeting_date AS "firstMeetingDate", person_one_name AS "personOneName", person_two_name AS "personTwoName" FROM users WHERE id = ?', [user.id]);
    const dateInput = Object.hasOwn(input, 'firstMeetingDate') ? input.firstMeetingDate : current.firstMeetingDate;
    const firstMeetingDate = dateInput === '' ? null : dateInput;
    const personOneName = Object.hasOwn(input, 'personOneName') ? normalizeDisplayName(input.personOneName) : current.personOneName;
    const personTwoName = Object.hasOwn(input, 'personTwoName') ? normalizeDisplayName(input.personTwoName) : current.personTwoName;
    if (firstMeetingDate !== null) {
      if (typeof firstMeetingDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(firstMeetingDate)) throw new HttpError(400, '相识日期格式无效');
      const [year, month, day] = firstMeetingDate.split('-').map(Number);
      const parsedDate = new Date(Date.UTC(year, month - 1, day));
      if (year < 1000 || parsedDate.getUTCFullYear() !== year || parsedDate.getUTCMonth() !== month - 1 || parsedDate.getUTCDate() !== day) {
        throw new HttpError(400, '相识日期无效');
      }
    }
    await run('UPDATE users SET first_meeting_date = ?, person_one_name = ?, person_two_name = ? WHERE id = ?',
      [firstMeetingDate, personOneName, personTwoName, user.id]);
    return json(200, { ok: true });
  }

  if (request.method === 'GET' && pathname === '/api/photos') {
    const account = await get('SELECT photo_revision FROM users WHERE id = ?', [user.id]);
    const revision = Number(account.photo_revision);
    const etag = `"${user.id}-${revision}"`;
    if (request.headers.get('if-none-match') === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': 'no-store' } });
    }
    const photos = await all(`SELECT id, name, width, height, thumbnail, size, created_at AS "createdAt"
      FROM photos WHERE user_id = ? ORDER BY created_at, id`, [user.id]);
    return json(200, {
      photos: photos.map((photo) => ({
        ...photo,
        aspectRatio: photo.width / photo.height,
        size: Number(photo.size),
        createdAt: Number(photo.createdAt),
        dataUrl: `/api/photos/${encodeURIComponent(photo.id)}/image`,
      })),
      revision,
    }, { ETag: etag });
  }

  if (request.method === 'POST' && pathname === '/api/photos') {
    if (!process.env.BLOB_READ_WRITE_TOKEN) throw new HttpError(503, '尚未配置 Vercel Blob，请绑定私有 Blob 存储');
    const input = await readJson(request, 700 * 1024);
    const photo = normalizePhotoMetadata(input);
    const intent = await get(`SELECT * FROM photo_uploads
      WHERE user_id = ? AND photo_id = ? AND expires_at > ?`, [user.id, photo.id, Date.now()]);
    if (!intent) throw new HttpError(409, '照片上传已过期，请重新上传');
    if (photo.name !== intent.name || photo.width !== intent.width || photo.height !== intent.height ||
        photo.thumbnail !== intent.thumbnail || photo.createdAt !== Number(intent.created_at)) {
      throw new HttpError(400, '照片信息与上传请求不一致');
    }
    if (typeof input.blobUrl !== 'string') throw new HttpError(400, '照片文件地址无效');
    let blobUrl;
    try { blobUrl = new URL(input.blobUrl); } catch { throw new HttpError(400, '照片文件地址无效'); }
    const blobPath = `photos/${user.id}/${photo.id}`;
    let suppliedPath;
    try { suppliedPath = decodeURIComponent(blobUrl.pathname.slice(1)); } catch { throw new HttpError(400, '照片文件地址无效'); }
    if (blobUrl.protocol !== 'https:' || !blobUrl.hostname.endsWith('.private.blob.vercel-storage.com') || suppliedPath !== blobPath) {
      throw new HttpError(400, '照片文件地址无效');
    }
    const blob = await getBlob(input.blobUrl, { access: 'private' });
    if (!blob || blob.statusCode !== 200 || !blob.blob.contentType ||
        !['image/jpeg', 'image/png', 'image/webp'].includes(blob.blob.contentType) ||
        !Number.isSafeInteger(blob.blob.size) || blob.blob.size < 1 || blob.blob.size > maxImageBytes || !blob.stream ||
        blob.blob.pathname !== blobPath || !await hasImageSignature(blob.stream, blob.blob.contentType)) {
      await del(input.blobUrl, { access: 'private' }).catch(() => undefined);
      await run('DELETE FROM photo_uploads WHERE user_id = ? AND photo_id = ?', [user.id, photo.id]);
      throw new HttpError(400, '仅支持不超过 25 MB 的有效 JPG、PNG 或 WebP 图片');
    }
    const inserted = await query(`INSERT INTO photos
      (user_id, id, name, width, height, thumbnail, mime_type, blob_url, size, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (user_id, id) DO NOTHING RETURNING id`,
    [user.id, photo.id, photo.name, photo.width, photo.height, photo.thumbnail, blob.blob.contentType,
      input.blobUrl, blob.blob.size, photo.createdAt]);
    if (!inserted.length) throw new HttpError(409, '这张照片已经存在');
    await run('UPDATE users SET photo_revision = photo_revision + 1 WHERE id = ?', [user.id]);
    await run('DELETE FROM photo_uploads WHERE user_id = ? AND photo_id = ?', [user.id, photo.id]);
    return json(201, { ok: true });
  }

  if (request.method === 'DELETE' && pathname === '/api/photos') {
    if (!process.env.BLOB_READ_WRITE_TOKEN) throw new HttpError(503, '尚未配置 Vercel Blob，请绑定私有 Blob 存储');
    const photos = await all('SELECT blob_url FROM photos WHERE user_id = ?', [user.id]);
    const result = await run('DELETE FROM photos WHERE user_id = ?', [user.id]);
    await run('DELETE FROM photo_uploads WHERE user_id = ?', [user.id]);
    if (result.changes > 0) await run('UPDATE users SET photo_revision = photo_revision + 1 WHERE id = ?', [user.id]);
    if (photos.length) await del(photos.map((photo) => photo.blob_url), { access: 'private' }).catch(console.error);
    return json(200, { ok: true });
  }

  const imageMatch = pathname.match(/^\/api\/photos\/([^/]+)\/image$/);
  if (request.method === 'GET' && imageMatch) {
    if (!process.env.BLOB_READ_WRITE_TOKEN) throw new HttpError(503, '尚未配置 Vercel Blob，请绑定私有 Blob 存储');
    let id;
    try { id = decodeURIComponent(imageMatch[1]); } catch { throw new HttpError(400, '照片编号无效'); }
    const photo = await get('SELECT blob_url, mime_type, size FROM photos WHERE user_id = ? AND id = ?', [user.id, id]);
    if (!photo) throw new HttpError(404, '没有找到这张照片');
    const blob = await getBlob(photo.blob_url, { access: 'private' });
    if (!blob || blob.statusCode !== 200 || !blob.stream) throw new HttpError(404, '没有找到这张照片');
    const headers = new Headers({
      'Content-Type': photo.mime_type,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    if (blob.blob.size != null) headers.set('Content-Length', String(blob.blob.size));
    return new Response(blob.stream, { headers });
  }

  const photoMatch = pathname.match(/^\/api\/photos\/([^/]+)$/);
  if (request.method === 'DELETE' && photoMatch) {
    if (!process.env.BLOB_READ_WRITE_TOKEN) throw new HttpError(503, '尚未配置 Vercel Blob，请绑定私有 Blob 存储');
    let id;
    try { id = decodeURIComponent(photoMatch[1]); } catch { throw new HttpError(400, '照片编号无效'); }
    const photo = await get('SELECT blob_url FROM photos WHERE user_id = ? AND id = ?', [user.id, id]);
    if (!photo) throw new HttpError(404, '没有找到这张照片');
    await run('DELETE FROM photos WHERE user_id = ? AND id = ?', [user.id, id]);
    await run('UPDATE users SET photo_revision = photo_revision + 1 WHERE id = ?', [user.id]);
    await del(photo.blob_url, { access: 'private' }).catch(console.error);
    return json(200, { ok: true });
  }

  throw new HttpError(404, '没有找到这个接口');
}

export async function handleApi(request) {
  try {
    return await handleApiRequest(request, new URL(request.url));
  } catch (error) {
    const status = error instanceof HttpError ? error.status :
      error?.code === '23505' ? 409 : error?.message === '未配置 DATABASE_URL' ? 503 : 500;
    if (status >= 500 && !(error instanceof HttpError)) console.error(error);
    const message = error instanceof HttpError ? error.message :
      error?.message === '未配置 DATABASE_URL' ? '尚未配置 Vercel 数据库，请绑定 Neon Postgres' :
      '服务器暂时无法处理请求';
    return json(status, { error: message });
  }
}
