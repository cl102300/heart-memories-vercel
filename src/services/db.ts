import { apiRequest } from './api';
import { upload } from '@vercel/blob/client';

export const MAX_PHOTOS = 999;

export interface DbPhoto {
  id: string;
  name: string;
  width: number;
  height: number;
  aspectRatio: number;
  thumbnail: string;
  dataUrl?: string;
  size: number;
  createdAt: number;
  image?: Blob;
}

export interface PhotoSnapshot {
  photos: DbPhoto[];
  revision: number;
}

let cachedSnapshot: (PhotoSnapshot & { ownerId: string }) | null = null;

class DatabaseService {
  async getAllPhotos(ownerId: string): Promise<PhotoSnapshot> {
    const headers = new Headers();
    if (cachedSnapshot?.ownerId === ownerId) {
      headers.set('If-None-Match', `"${ownerId}-${cachedSnapshot.revision}"`);
    }

    const response = await fetch('/api/photos', { headers, credentials: 'same-origin' });
    if (response.status === 304 && cachedSnapshot?.ownerId === ownerId) return cachedSnapshot;
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || '读取相册失败');

    cachedSnapshot = { ...body, ownerId } as PhotoSnapshot & { ownerId: string };
    return cachedSnapshot;
  }

  async addPhotos(ownerId: string, photos: DbPhoto[]): Promise<void> {
    const addedIds: string[] = [];
    try {
      for (const photo of photos) {
        if (!photo.image) throw new Error(`无法上传“${photo.name}”，没有读取到图片数据`);
        const metadata = {
          id: photo.id,
          name: photo.name,
          width: photo.width,
          height: photo.height,
          createdAt: photo.createdAt,
          thumbnail: photo.thumbnail,
        };
        const blob = await upload(`photos/${ownerId}/${photo.id}`, photo.image, {
          access: 'private',
          contentType: photo.image.type,
          handleUploadUrl: '/api/blob-upload',
          clientPayload: JSON.stringify(metadata),
          multipart: true,
        });
        await apiRequest('/api/photos', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...metadata, blobUrl: blob.url }),
        });
        addedIds.push(photo.id);
      }
      this.invalidate();
    } catch (error) {
      await Promise.all(addedIds.map((id) =>
        apiRequest(`/api/photos/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => undefined)
      ));
      this.invalidate();
      throw error;
    }
  }

  async deletePhoto(id: string): Promise<void> {
    await apiRequest(`/api/photos/${encodeURIComponent(id)}`, { method: 'DELETE' });
    this.invalidate();
  }

  async clearAll(): Promise<void> {
    await apiRequest('/api/photos', { method: 'DELETE' });
    this.invalidate();
  }

  async count(ownerId: string): Promise<number> {
    return (await this.getAllPhotos(ownerId)).photos.length;
  }

  invalidate(): void {
    cachedSnapshot = null;
  }
}

export const dbService = new DatabaseService();
