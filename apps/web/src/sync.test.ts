import { describe, expect, it } from 'vitest';
import { FIRST_WINDOW, MAX_ROOMS, nextWindowEnd } from './sync.ts';

describe('окно списка Sliding Sync', () => {
  it('сначала 20 комнат, затем шагами по 100 до всех комнат', () => {
    let end = FIRST_WINDOW - 1;
    const steps: number[] = [];
    for (let next = nextWindowEnd(end, 257); next !== null; next = nextWindowEnd(end, 257)) steps.push((end = next));
    expect(steps).toEqual([119, 219, 256]);
  });

  it('комнат меньше окна — расширять нечего; больше предела — останавливаемся на нём', () => {
    expect(nextWindowEnd(FIRST_WINDOW - 1, 7)).toBeNull();
    expect(nextWindowEnd(FIRST_WINDOW - 1, 0)).toBeNull();
    let end = FIRST_WINDOW - 1;
    for (let next = nextWindowEnd(end, 5000); next !== null; next = nextWindowEnd(end, 5000)) end = next;
    expect(end).toBe(MAX_ROOMS - 1);
  });
});
