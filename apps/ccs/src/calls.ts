import { createHmac } from 'node:crypto';
import { AccessToken } from 'livekit-server-sdk';
import type { MatrixApi } from './matrix.ts';

export class ForbiddenError extends Error {}

export interface CallTokenResult {
  url: string;
  token: string;
  room: string;
}

/**
 * Токены LiveKit выдаются только участникам комнаты Matrix (проверка — токеном самого пользователя).
 * Имя комнаты LiveKit непредсказуемо: HMAC(room_id, call_id). Подробнее — docs/03-architecture.md, раздел 7.
 */
export class CallTokenService {
  constructor(
    private readonly matrix: MatrixApi,
    private readonly opts: { url: string; apiKey: string; apiSecret: string; roomSecret: string; ttl?: string; internalUrl?: string },
  ) {}

  livekitRoomName(roomId: string, callId: string): string {
    return 'call-' + createHmac('sha256', this.opts.roomSecret).update(`${roomId}\n${callId}`).digest('hex').slice(0, 24);
  }

  async issue(userAccessToken: string, roomId: string, callId = 'main'): Promise<CallTokenResult> {
    const userId = await this.matrix.whoami(userAccessToken);
    let members: string[];
    try {
      members = await this.matrix.joinedMembersAs(userAccessToken, roomId);
    } catch {
      throw new ForbiddenError('Нет доступа к комнате');
    }
    if (!members.includes(userId)) throw new ForbiddenError('Пользователь не состоит в комнате');

    const room = this.livekitRoomName(roomId, callId);
    // Имя в плитке звонка — из профиля Matrix, а не от клиента.
    const name = (await this.matrix.displayName(userId).catch(() => null)) ?? userId;
    const at = new AccessToken(this.opts.apiKey, this.opts.apiSecret, { identity: userId, name, ttl: this.opts.ttl ?? '10m' });
    at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true, canPublishData: true });
    return { url: this.opts.url, token: await at.toJwt(), room };
  }

  /**
   * Токен ИИ-агента («Секретарь»): только слушает — без права публиковать. Адрес LiveKit — внутренний,
   * если агент работает в той же сети, что и LiveKit.
   */
  async agentToken(roomId: string, callId: string, identity: string, name: string): Promise<CallTokenResult> {
    const room = this.livekitRoomName(roomId, callId);
    const at = new AccessToken(this.opts.apiKey, this.opts.apiSecret, { identity, name, ttl: '6h' });
    at.addGrant({ roomJoin: true, room, canPublish: false, canSubscribe: true, canPublishData: false });
    return { url: this.opts.internalUrl ?? this.opts.url, token: await at.toJwt(), room };
  }
}
