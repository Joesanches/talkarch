/** Подписи для текстов, которые сервис пишет в чат. */

const roleNames: Record<string, string> = {
  pathologist: 'патоморфолог',
  radiologist: 'рентгенолог',
  attending: 'лечащий врач',
  lab_tech: 'лаборант',
  radiographer: 'рентгенолаборант',
  engineer: 'инженер',
  head: 'заведующий',
  external_consultant: 'консультант',
  on_duty: 'дежурный врач',
  viewer: 'наблюдатель',
};

export const roleName = (role: string) => roleNames[role] ?? role;

/** «45 с», «2 мин 13 с», «1 ч 5 мин». */
export function formatDelay(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} с`;
  if (s < 3600) return s % 60 ? `${Math.floor(s / 60)} мин ${s % 60} с` : `${s / 60} мин`;
  const m = Math.round((s % 3600) / 60);
  return m ? `${Math.floor(s / 3600)} ч ${m} мин` : `${Math.floor(s / 3600)} ч`;
}
