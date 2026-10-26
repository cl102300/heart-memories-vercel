import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { put } from '@vercel/blob';
import { all, get, run } from '../server/database.mjs';

if (!process.env.DATABASE_URL) throw new Error('请先设置 DATABASE_URL');
if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error('请先设置 BLOB_READ_WRITE_TOKEN');

const databasePath = resolve(import.meta.dirname, '../data/heart-memories.sqlite');
const sqlite = new DatabaseSync(databasePath, { readOnly: true });
const mimeTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
let userCount = 0;
let photoCount = 0;

try {
  await get('SELECT 1');
  const users = sqlite.prepare(`SELECT id, username, username_key, password_salt, password_hash,
    photo_revision, created_at, first_meeting_date, person_one_name, person_two_name, phone_number
    FROM users ORDER BY created_at`).all();
  const photos = sqlite.prepare(`SELECT user_id, id, name, width, height, thumbnail, mime_type, image, size, created_at
    FROM photos ORDER BY user_id, created_at, id`).all();

  for (const user of users) {
    await run(`INSERT INTO users
      (id, username, username_key, password_salt, password_hash, photo_revision, created_at,
       first_meeting_date, person_one_name, person_two_name, phone_number)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`, [
      user.id, user.username, user.username_key,
      Buffer.from(user.password_salt).toString('hex'), Buffer.from(user.password_hash).toString('hex'),
      user.photo_revision, user.created_at, user.first_meeting_date, user.person_one_name,
      user.person_two_name, user.phone_number,
    ]);
    userCount += 1;
  }

  for (const photo of photos) {
    if (!mimeTypes.has(photo.mime_type)) throw new Error(`照片“${photo.name}”的格式无法迁移`);
    if (await get('SELECT 1 FROM photos WHERE user_id = ? AND id = ?', [photo.user_id, photo.id])) continue;
    const image = Buffer.from(photo.image);
    const blob = await put(`photos/${photo.user_id}/${photo.id}`, image, {
      access: 'private',
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: photo.mime_type,
    });
    await run(`INSERT INTO photos
      (user_id, id, name, width, height, thumbnail, mime_type, blob_url, size, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (user_id, id) DO NOTHING`, [
      photo.user_id, photo.id, photo.name, photo.width, photo.height, photo.thumbnail,
      photo.mime_type, blob.url, image.byteLength, photo.created_at,
    ]);
    photoCount += 1;
  }

  const existing = await all('SELECT COUNT(*) AS count FROM users');
  console.log(`迁移完成：处理 ${userCount} 个账号、${photoCount} 张照片。云端账号总数：${existing[0].count}`);
} finally {
  sqlite.close();
}
