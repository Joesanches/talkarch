import { useState } from 'react';
import { Login } from './components/Login.tsx';
import { Messenger } from './components/Messenger.tsx';
import { EmbedApp } from './embed/EmbedApp.tsx';
import { clearSession, loadSession, saveSession, type Session } from './matrix.ts';

export function App() {
  // Чат во фрейме РИС/ЛИС (SDK встраивания) — отдельная оболочка.
  if (location.pathname === '/embed') return <EmbedApp />;
  return <Standalone />;
}

function Standalone() {
  const [session, setSession] = useState<Session | null>(loadSession);
  if (!session) {
    return (
      <Login
        onLogin={(s) => {
          saveSession(s);
          setSession(s);
        }}
      />
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
