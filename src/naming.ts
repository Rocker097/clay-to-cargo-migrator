// Slug and identifier helpers. Cargo resources and columns use snake_case
// slugs; generated TypeScript variables use camelCase.

const RESERVED = new Set(["id", "accounts", "contacts"]);

export function slugify(name: string, maxLength = 40): string {
  let s = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!s) s = "column";
  if (/^[0-9]/.test(s)) s = `c_${s}`;
  if (s.length > maxLength) s = s.slice(0, maxLength).replace(/_+$/g, "");
  if (RESERVED.has(s)) s = `${s}_col`;
  return s;
}

export function camel(slug: string): string {
  return slug.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

export class SlugRegistry {
  private used = new Set<string>();
  constructor(reserved: string[] = []) {
    reserved.forEach((r) => this.used.add(r));
  }
  take(name: string, maxLength = 40): string {
    const base = slugify(name, maxLength);
    let slug = base;
    let n = 2;
    while (this.used.has(slug)) slug = `${base}_${n++}`;
    this.used.add(slug);
    return slug;
  }
}
