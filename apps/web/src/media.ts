import { useEffect, useState } from 'react';
import { MsgType, KeyImage, type CaseContext } from '@konsilium/protocol';
import type { KeyImageAttachment, UnreadItem } from '@konsilium/embed/protocol';
import { EventType, RoomType } from '@konsilium/protocol';
import { NotificationCountType, type MatrixClient } from 'matrix-js-sdk';
import { parseCaseContext } from './model.ts';

/**
 * Медиа Synapse требует авторизацию (authenticated media), поэтому <img src> не подходит:
 * скачиваем с токеном и показываем через blob: URL.
 */
export function useAuthedMedia(client: MatrixClient, mxc: string | undefined, size = { w: 640, h: 480 }): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!mxc) return;
    let objectUrl: string | null = null;
    let cancelled = false;
    const http = client.mxcUrlToHttp(mxc, size.w, size.h, 'scale', false, true, true);
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
  }, [client, mxc, size.w, size.h]);
  return url;
}

const MAX_THUMBNAIL = 2 * 1024 * 1024;

/** Ключевой снимок из вьюера хоста → сообщение ru.vendor.key_image (миниатюра загружается на сервер сообщений). */
export async function sendKeyImage(client: MatrixClient, roomId: string, att: KeyImageAttachment): Promise<void> {
  let thumbnail: string | undefined;
  if (att.thumbnail) {
    if (!/^data:image\/(png|jpeg|webp);base64,/.test(att.thumbnail)) throw new Error('Миниатюра должна быть data:image/png, jpeg или webp');
    const blob = await (await fetch(att.thumbnail)).blob();
    if (blob.size > MAX_THUMBNAIL) throw new Error('Миниатюра больше 2 МБ');
    thumbnail = (await client.uploadContent(blob, { type: blob.type, name: 'key-image' })).content_uri;
  }
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
  for (const room of client.getRooms()) {
    const membership = room.getMyMembership();
    if ((membership !== 'join' && membership !== 'invite') || room.getType() !== RoomType.Case) continue;
    const ctx: CaseContext | null = parseCaseContext(room.currentState.getStateEvents(EventType.CaseContext, '')?.getContent());
    if (!ctx) continue;
    out.push({
      roomId: room.roomId,
      connector: ctx.connector,
      caseId: ctx.case_id,
      unread: membership === 'invite' ? 0 : room.getUnreadNotificationCount(NotificationCountType.Total),
      invited: membership === 'invite',
    });
  }
  return out;
}
