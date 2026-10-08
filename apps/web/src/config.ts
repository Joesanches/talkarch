/**
 * Адреса сервера сообщений и сервиса контекста.
 * Порядок: /config.json рядом с веб-клиентом (стенд, продукт) → переменные сборки VITE_HS_URL / VITE_CCS_URL →
 * окружение разработчика. Так один собранный клиент подходит для любого домена.
 */
export const config = {
  hsUrl: (import.meta.env.VITE_HS_URL as string | undefined) ?? 'http://localhost:8008',
  ccsUrl: (import.meta.env.VITE_CCS_URL as string | undefined) ?? 'http://localhost:8080',
  /** Origin страниц РИС/ЛИС, которым разрешено встраивать чат (кроме своего). */
  embedOrigins: [] as string[],
  /** Конфигурация прочитана из /config.json (стенд, продукт), а не взята по умолчанию для разработки. */
  fromFile: false,
};

/** Прочитать /config.json, если он есть. Ошибки не мешают запуску — остаются значения по умолчанию. */
export async function loadRuntimeConfig(): Promise<void> {
  try {
    const res = await fetch('/config.json', { cache: 'no-store' });
    if (!res.ok || !res.headers.get('content-type')?.includes('json')) return;
    const json = (await res.json()) as { hsUrl?: unknown; ccsUrl?: unknown; embedOrigins?: unknown };
    if (typeof json.hsUrl === 'string') config.hsUrl = json.hsUrl.replace(/\/$/, '');
    if (typeof json.ccsUrl === 'string') config.ccsUrl = json.ccsUrl.replace(/\/$/, '');
    if (Array.isArray(json.embedOrigins)) config.embedOrigins = json.embedOrigins.filter((o): o is string => typeof o === 'string');
    config.fromFile = true;
  } catch {
    /* нет файла — окружение разработчика */
  }
}

/** Можно ли странице с этим origin встраивать чат: свой домен, список из config.json; в разработке — localhost. */
export function isAllowedHostOrigin(origin: string): boolean {
  if (!origin) return false;
  if (origin === location.origin || config.embedOrigins.includes(origin)) return true;
  return !config.fromFile && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}
