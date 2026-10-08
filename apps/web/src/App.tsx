import { useEffect, useState } from 'react';
import { Login, SsoDone } from './components/Login.tsx';
import { Messenger } from './components/Messenger.tsx';
import { EmbedApp } from './embed/EmbedApp.tsx';
import { clearSession, loadSession, loginWithToken, saveSession, type Session } from './matrix.ts';

export function App() {
  // Чат во фрейме РИС/ЛИС (SDK встраивания) — отдельная оболочка.
  if (location.pathname === '/embed') return <EmbedApp />;
  // Возврат единого входа во всплывающем окне (вход во фрейме).
  if (location.pathname === '/sso-done') return <SsoDone onLogin={saveSession} />;
  return <Standalone />;
}

/**
 * Одноразовый токен единого входа в адресе (возврат из Keycloak) — читается один раз при загрузке модуля
 * (не в React: строгий режим вызывает инициализаторы дважды) и сразу убирается из адреса.
 */
const ssoToken: string | null = (() => {
  if (location.pathname === '/sso-done' || location.pathname === '/embed') return null;
  const url = new URL(location.href);
  const token = url.searchParams.get('loginToken');
  if (!token) return null;
  url.searchParams.delete('loginToken');
  history.replaceState(null, '', url.pathname + url.search + url.hash);
  return token;
})();

function Standalone() {
  const [session, setSession] = useState<Session | null>(loadSession);
  // Токен из адреса — до конца обмена; после него (успех или ошибка) экрана «Вход…» больше нет, в т.ч. после выхода.
  const [pendingToken, setPendingToken] = useState(ssoToken);
  const [ssoError, setSsoError] = useState<string | null>(null);
  const signIn = (s: Session) => {
    saveSession(s);
    setSession(s);
  };

  useEffect(() => {
    if (!pendingToken) return;
    loginWithToken(pendingToken)
      .then(signIn)
      .catch(() => setSsoError('Вход через учётную запись организации не завершён — попробуйте снова'))
      .finally(() => setPendingToken(null));
  }, [pendingToken]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!session) {
    if (pendingToken && !ssoError) {
      return (
        <main className="login">
          <div className="login-card" role="status">
            Вход…
          </div>
        </main>
      );
    }
    return (
      <>
        {ssoError && (
          <div className="banner" role="alert">
            {ssoError}
          </div>
        )}
        <Login onLogin={signIn} />
      </>
    );
  }
  return (
    <Messenger
      key={session.accessToken}
      session={session}
      onLogout={() => {
        clearSession();
        setSession(null);
      }}
    />
  );
}
