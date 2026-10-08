import { useEffect, useState, type FormEvent } from 'react';
import { config } from '../config.ts';
import { login, loginOptions, loginWithToken, ssoLoginUrl, SSO_MESSAGE, type LoginOptions, type Session } from '../matrix.ts';

/** Адрес текущей страницы без одноразового токена — сюда вернёт единый вход (ссылка на случай сохраняется). */
function returnUrl(): string {
  const url = new URL(location.href);
  url.searchParams.delete('loginToken');
  return url.toString();
}

/**
 * Вход: единый вход через учётную запись организации (Keycloak) — основной способ; пароль — запасной
 * (тестовые учётные записи, стенд без Keycloak).
 * `sso="popup"` — во фрейме РИС/ЛИС: страницу входа организации нельзя показать в чужом фрейме, поэтому она
 * открывается во всплывающем окне, а одноразовый токен возвращается сообщением.
 */
export function Login({ onLogin, sso = 'redirect' }: { onLogin: (s: Session) => void; sso?: 'redirect' | 'popup' }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [options, setOptions] = useState<LoginOptions | null>(null);

  useEffect(() => {
    loginOptions()
      .then(setOptions)
      .catch(() => setOptions({ password: true, sso: [] }));
  }, []);

  // Ответ всплывающего окна единого входа (только с нашего origin).
  useEffect(() => {
    if (sso !== 'popup') return;
    const on = (e: MessageEvent) => {
      if (e.origin !== location.origin || (e.data as { type?: string } | null)?.type !== SSO_MESSAGE) return;
      const token = (e.data as { loginToken?: unknown }).loginToken;
      if (typeof token !== 'string') return;
      setBusy(true);
      loginWithToken(token)
        .then(onLogin)
        .catch(() => setError('Не удалось завершить вход через учётную запись организации'))
        .finally(() => setBusy(false));
    };
    window.addEventListener('message', on);
    return () => window.removeEventListener('message', on);
  }, [sso, onLogin]);

  function ssoStart(idpId: string) {
    setError(null);
    if (sso === 'redirect') return location.assign(ssoLoginUrl(returnUrl(), idpId));
    const popup = window.open(ssoLoginUrl(`${location.origin}/sso-done`, idpId), 'konsilium-sso', 'popup,width=480,height=680');
    if (!popup) setError('Браузер заблокировал окно входа — разрешите всплывающие окна для этого сайта');
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onLogin(await login(username, password));
    } catch (err) {
      const e = err as { errcode?: string; data?: { retry_after_ms?: number } };
      if (e.errcode === 'M_LIMIT_EXCEEDED') {
        const sec = Math.ceil((e.data?.retry_after_ms ?? 60_000) / 1000);
        setError(`Слишком много попыток входа. Повторите через ${sec} с`);
      } else if (e.errcode === 'M_FORBIDDEN') {
        setError('Неверный логин или пароль');
      } else {
        setError('Сервер недоступен, попробуйте позже');
      }
    } finally {
      setBusy(false);
    }
  }

  const ssoProviders = options?.sso ?? [];
  const showPassword = !options || options.password;
  return (
    <main className="login">
      <form className="login-card" onSubmit={submit}>
        <div className="login-logo" aria-hidden>
          К
        </div>
        <h1>Консилиум</h1>
        {ssoProviders.map((p) => (
          <button key={p.id} type="button" className="primary" onClick={() => ssoStart(p.id)} disabled={busy}>
            Войти через {p.name}
          </button>
        ))}
        {showPassword && (
          <>
            {ssoProviders.length > 0 ? <p className="login-divider">или по логину и паролю</p> : <p className="muted">Вход для сотрудников</p>}
            <label>
              Логин
              <input name="username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus={!ssoProviders.length} />
            </label>
            <label>
              Пароль
              <input name="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </label>
            <button className={ssoProviders.length ? 'ghost' : 'primary'} type="submit" disabled={busy}>
              {busy ? 'Вход…' : 'Войти'}
            </button>
          </>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <p className="meta">Сервер: {config.hsUrl}</p>
      </form>
    </main>
  );
}

/**
 * Возврат единого входа (`/sso-done?loginToken=…`). Открыто фреймом РИС/ЛИС — отдаём токен ему и закрываемся;
 * иначе входим сами и уходим на главную.
 */
export function SsoDone({ onLogin }: { onLogin: (s: Session) => void }) {
  const [text, setText] = useState('Завершаем вход…');
  useEffect(() => {
    const token = new URLSearchParams(location.search).get('loginToken');
    if (!token) return setText('Нет данных входа. Закройте окно и попробуйте снова.');
    const opener = window.opener as Window | null;
    if (opener && opener !== window) {
      // Фрейм обменяет токен сам; повтор сообщения (строгий режим React) он получит тот же — обмен один.
      opener.postMessage({ type: SSO_MESSAGE, loginToken: token }, location.origin);
      setText('Вход выполнен — окно можно закрыть.');
      window.close();
      return;
    }
    loginWithToken(token)
      .then((s) => {
        onLogin(s);
        location.replace('/');
      })
      .catch(() => setText('Не удалось завершить вход. Вернитесь в приложение и попробуйте снова.'));
    // Токен одноразовый: обмениваем ровно один раз, при первом показе.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <main className="login">
      <div className="login-card" role="status">
        {text}
      </div>
    </main>
  );
}
