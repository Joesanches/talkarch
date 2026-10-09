import { useState } from 'react';

const DISMISSED = 'konsilium.notifications.dismissed';

/**
 * Предложение включить уведомления браузера. Разрешение браузер спрашивает только по действию пользователя, поэтому —
 * кнопка, а не запрос при входе. «Не сейчас» запоминается в этом браузере.
 */
export function NotificationsPrompt() {
  const supported = typeof Notification !== 'undefined';
  const [permission, setPermission] = useState<NotificationPermission>(() => (supported ? Notification.permission : 'denied'));
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISSED) === '1';
    } catch {
      return false;
    }
  });
  if (!supported || permission !== 'default' || dismissed) return null;
  return (
    <div className="banner notify-prompt" role="region" aria-label="Уведомления браузера">
      <span>Включите уведомления, чтобы не пропустить сообщения, критические находки и звонки, пока вкладка открыта</span>
      <button className="notify-allow" onClick={() => void Notification.requestPermission().then(setPermission)}>
        Включить
      </button>
      <button
        aria-label="Не сейчас"
        onClick={() => {
          setDismissed(true);
          try {
            localStorage.setItem(DISMISSED, '1');
          } catch {
            /* приватный режим — не запоминаем */
          }
        }}
      >
        ×
      </button>
    </div>
  );
}
