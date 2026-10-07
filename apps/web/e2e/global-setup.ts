import { DEV_PASSWORD, ensureDevUsers } from '@konsilium/host-mock/users';

export const PASSWORD = DEV_PASSWORD;

/** Пользователи стенда с именами (как `pnpm dev:users`). Нужен Synapse из infra/. */
export default async function globalSetup() {
  await ensureDevUsers();
}
