import { useEffect, useState } from 'react';
import { MsgType, KeyImage, SlideRoi, type CaseContext } from '@konsilium/protocol';
import type { KeyImageAttachment, SlideAttachment, UnreadItem } from '@konsilium/embed/protocol';
import { EventType, RoomType } from '@konsilium/protocol';
import type { MatrixClient } from 'matrix-js-sdk';
import { roomCriticals, unreadCount } from './matrix.ts';
import { criticalWaitingFor, parseCaseContext } from './model.ts';

/**
 * Медиа Synapse требует авторизацию (authenticated media), поэтому <img src> не подходит:
 * скачиваем с токеном и показываем через blob: URL.
 */
export function useAuthedMedia(client: MatrixClient, mxc: string | undefined, size: { w: number; h: number } | null = { w: 640, h: 480 }): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const w = size?.w;
  const h = size?.h;
  useEffect(() => {
    if (!mxc) return;
    let objectUrl: string | null = null;
    let cancelled = false;
    // С размером — миниатюра, которую считает сервер; без размера — исходный файл.
    const http = w && h ? client.mxcUrlToHttp(mxc, w, h, 'scale', false, true, true) : client.mxcUrlToHttp(mxc, undefined, undefined, undefined, false, true, true);
    if (!http) return;
    fetch(http, { headers: { authorization: `Bearer ${client.getAccessToken()}` } })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [client, mxc, w, h]);
  return url;
}

const DEFAULT_UPLOAD_LIMIT = 50 * 1024 * 1024;
const uploadLimits = new WeakMap<MatrixClient, Promise<number>>();

/** Предел размера загрузки на сервере (`m.upload.size`); если сервер не сообщает — 50 МБ, как у Synapse по умолчанию. */
export function maxUploadBytes(client: MatrixClient): Promise<number> {
  let p = uploadLimits.get(client);
  if (!p) {
    p = client
      .getMediaConfig()
      .then((c) => c['m.upload.size'] ?? DEFAULT_UPLOAD_LIMIT)
      .catch(() => DEFAULT_UPLOAD_LIMIT);
    uploadLimits.set(client, p);
  }
  return p;
}

const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp)$/;

/**
 * Отправить файл в чат: изображение — `m.image` с размерами (миниатюры сервер считает сам), остальное — `m.file`.
 * Файл остаётся на сервере сообщений организации; доступ — только участникам комнаты (authenticated media).
 */
export async function sendAttachment(
  client: MatrixClient,
  roomId: string,
  file: File,
  opts: { replyTo?: string | null; onProgress?: (pct: number) => void } = {},
): Promise<void> {
  const type = file.type || 'application/octet-stream';
  const { content_uri } = await client.uploadContent(file, {
    name: file.name,
    type,
    progressHandler: ({ loaded, total }) => opts.onProgress?.(total ? Math.round((loaded / total) * 100) : 0),
  });
  const image = IMAGE_TYPES.test(type);
  const info: Record<string, unknown> = { mimetype: type, size: file.size };
  if (image) {
    try {
      const bmp = await createImageBitmap(file);
      info.w = bmp.width;
      info.h = bmp.height;
      bmp.close();
    } catch {
      /* размеры не обязательны */
    }
  }
  await client.sendMessage(roomId, {
    msgtype: image ? 'm.image' : 'm.file',
    body: file.name,
    filename: file.name,
    url: content_uri,
    info,
    ...(opts.replyTo ? { 'm.relates_to': { 'm.in_reply_to': { event_id: opts.replyTo } } } : {}),
  } as never);
}

/** Скачать вложение (с токеном: authenticated media) и сохранить под исходным именем. */
export async function downloadMedia(client: MatrixClient, mxc: string, filename: string): Promise<void> {
  const http = client.mxcUrlToHttp(mxc, undefined, undefined, undefined, false, true, true);
  if (!http) throw new Error('Неверная ссылка на файл');
  const res = await fetch(http, { headers: { authorization: `Bearer ${client.getAccessToken()}` } });
  if (!res.ok) throw new Error(`Сервер ответил ${res.status}`);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const MAX_THUMBNAIL = 2 * 1024 * 1024;

/** Миниатюра от хоста (data: URL) → файл на сервере сообщений. */
async function uploadThumbnail(client: MatrixClient, dataUrl: string | undefined, name: string): Promise<string | undefined> {
  if (!dataUrl) return undefined;
  if (!/^data:image\/(png|jpeg|webp);base64,/.test(dataUrl)) throw new Error('Миниатюра должна быть data:image/png, jpeg или webp');
  const blob = await (await fetch(dataUrl)).blob();
  if (blob.size > MAX_THUMBNAIL) throw new Error('Миниатюра больше 2 МБ');
  return (await client.uploadContent(blob, { type: blob.type, name })).content_uri;
}

/** Стекло или область препарата из ЛИС → сообщение ru.vendor.slide_roi (миниатюра загружается на сервер сообщений). */
export async function sendSlideRoi(client: MatrixClient, roomId: string, att: SlideAttachment): Promise<void> {
  const thumbnail = await uploadThumbnail(client, att.thumbnail, 'slide');
  const content = SlideRoi.parse({
    msgtype: MsgType.SlideRoi,
    body: att.caption?.trim() || `Стекло ${att.slideId}${att.block ? `, блок ${att.block}` : ''}: ${att.stain}`,
    [MsgType.SlideRoi]: {
      slide_id: att.slideId,
      ...(att.block ? { block: att.block } : {}),
      stain: att.stain,
      magnification: att.magnification,
      ...(att.region ? { region: att.region } : {}),
      ...(thumbnail ? { thumbnail } : {}),
      ...(att.viewerUrl ? { link: { kind: 'viewer', url: att.viewerUrl } } : {}),
    },
  });
  await client.sendMessage(roomId, content as never);
}

/** Ключевой снимок из вьюера хоста → сообщение ru.vendor.key_image (миниатюра загружается на сервер сообщений). */
export async function sendKeyImage(client: MatrixClient, roomId: string, att: KeyImageAttachment): Promise<void> {
  const thumbnail = await uploadThumbnail(client, att.thumbnail, 'key-image');
  const frame = att.frame ?? 1;
  const content = KeyImage.parse({
    msgtype: MsgType.KeyImage,
    body: att.caption?.trim() || `Ключевой снимок, кадр ${frame}`,
    [MsgType.KeyImage]: {
      study_uid: att.studyUid,
      series_uid: att.seriesUid,
      sop_uid: att.sopUid,
      frame,
      ...(att.presentation ? { presentation: att.presentation } : {}),
      ...(thumbnail ? { thumbnail } : {}),
      ...(att.viewerUrl ? { link: { kind: 'viewer', url: att.viewerUrl } } : {}),
    },
  });
  await client.sendMessage(roomId, content as never);
}

/** Непрочитанное по чатам случаев. Приглашения считаются новыми чатами (контекст в них — из room_prejoin_state). */
export function caseUnread(client: MatrixClient): Array<UnreadItem & { roomId: string }> {
  const out: Array<UnreadItem & { roomId: string }> = [];
  const me = client.getUserId();
  for (const room of client.getRooms()) {
    const membership = room.getMyMembership();
    if ((membership !== 'join' && membership !== 'invite') || room.getType() !== RoomType.Case) continue;
    const ctx: CaseContext | null = parseCaseContext(room.currentState.getStateEvents(EventType.CaseContext, '')?.getContent());
    if (!ctx) continue;
    out.push({
      roomId: room.roomId,
      connector: ctx.connector,
      caseId: ctx.case_id,
      unread: membership === 'invite' ? 0 : unreadCount(room),
      invited: membership === 'invite',
      critical: me ? criticalWaitingFor(roomCriticals(room), me).length : 0,
    });
  }
  return out;
}
