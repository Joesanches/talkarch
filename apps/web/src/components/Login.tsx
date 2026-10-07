import { useState, type FormEvent } from 'react';
import { HS_URL } from '../config.ts';
import { login, type Session } from '../matrix.ts';

export function Login({ onLogin }: { onLogin: (s: Session) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onLogin(await login(username, password));
    } catch {
      setError('Не удалось войти: проверьте логин и пароль');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <form className="login-card" onSubmit={submit}>
        <div className="login-logo" aria-hidden>К</div>
        <h1>Консилиум</h1>
        <p className="muted">Вход для сотрудников. В продукте — единый вход через учётную запись организации.</p>
        <label>
          Логин
          <input name="username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus />
        </label>
        <label>
          Пароль
          <input name="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary" type="submit" disabled={busy}>
          {busy ? 'Вход…' : 'Войти'}
        </button>
        <p className="meta">Сервер: {HS_URL}</p>
      </form>
    </main>
  );
}
