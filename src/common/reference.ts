import { isIntegrityViolation } from './error-handler';

/** Short random references; the unique index decides, and a clash just draws again. */
export async function withUniqueReference<T>(next: () => string, insert: (ref: string) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await insert(next());
    } catch (e) {
      if (!isIntegrityViolation(e) || attempt >= 9) throw e;
    }
  }
}
