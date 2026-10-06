/** URL slugs of variant SKUs (NFR-04): lowercase words joined by hyphens. */
export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const MAX_SLUG_LENGTH = 255;

/** "Men's Crew Tee — Black / M" → "mens-crew-tee-black-m". */
export function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 200)
    .replace(/-+$/, '');
}

/** `base`, or `base-2`, `base-3`… whichever is not yet taken; marks it taken. */
export function nextFree(base: string, taken: Set<string>): string {
  let code = base;
  for (let n = 2; taken.has(code); n++) code = `${base}-${n}`;
  taken.add(code);
  return code;
}
