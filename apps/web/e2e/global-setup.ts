import { ensureDevUsers } from '@konsilium/host-mock/users';

/** Пользователи стенда с именами (как `pnpm dev:users`). Нужен Synapse из infra/. */
export default async function globalSetup() {
  await ensureDevUsers();
}
