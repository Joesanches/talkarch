/** Адреса сервера сообщений и сервиса контекста. В продукте их отдаёт сервер веб-клиента (/config.json). */
export const HS_URL: string = import.meta.env.VITE_HS_URL ?? 'http://localhost:8008';
export const CCS_URL: string = import.meta.env.VITE_CCS_URL ?? 'http://localhost:8080';
