/**
 * schema.org structured data (JSON-LD) → compact facts.
 *
 * Most product, recipe, event, job and article pages already embed machine-
 * readable data for search engines. Reading it is free, exact and needs no
 * LLM — the opposite of "AI extraction" priced per page.
 */
export interface StructuredItem {
  type: string;
  /** Condensed, human-meaningful fields (price, rating, dates…). */
  facts: Record<string, string | number | string[]>;
}

type Node = Record<string, unknown>;

const INTERESTING = /^(Product|ProductGroup|Offer|Recipe|Event|\w*Event|JobPosting|Organization|LocalBusiness|\w*Store|Restaurant|Article|NewsArticle|BlogPosting|FAQPage|HowTo|Movie|TVSeries|Book|SoftwareApplication|MobileApplication|Course|Review|VideoObject|PodcastEpisode|Person|Dataset|Place|Hotel)$/;

export function extractJsonLd(html: string): Node[] {
  const out: Node[] = [];
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(m[1]!.trim().replace(/^<!--|-->$/g, ''));
    } catch {
      continue; // malformed JSON-LD is common
    }
    const stack: unknown[] = Array.isArray(parsed) ? [...parsed] : [parsed];
    while (stack.length) {
      const n = stack.shift();
      if (!n || typeof n !== 'object') continue;
      const node = n as Node;
      if (Array.isArray(node['@graph'])) stack.push(...(node['@graph'] as unknown[]));
      if (node['@type']) out.push(node);
    }
  }
  return out;
}

export function summarizeStructured(nodes: Node[], max = 8): StructuredItem[] {
  const items: StructuredItem[] = [];
  for (const n of nodes) {
    const types = ([] as unknown[]).concat(n['@type']).map(String);
    const type = types.find((t) => INTERESTING.test(t));
    if (!type) continue;
    const facts = factsFor(type, n);
    if (Object.keys(facts).length >= 2) items.push({ type, facts });
    if (items.length >= max) break;
  }
  return items;
}

function factsFor(type: string, n: Node): StructuredItem['facts'] {
  const f: StructuredItem['facts'] = {};
  const set = (k: string, v: unknown) => {
    const s = flat(v);
    if (s !== undefined && s !== '' && !(Array.isArray(s) && !s.length)) f[k] = s;
  };
  set('name', n.name ?? n.headline ?? n.title);
  if (/Product/.test(type)) {
    set('brand', name(n.brand));
    set('sku', n.sku ?? n.gtin13 ?? n.gtin ?? n.mpn);
    const offer = first(n.offers);
    set('price', offer?.price ?? offer?.lowPrice ?? first(offer?.priceSpecification)?.price);
    set('highPrice', offer?.highPrice);
    set('currency', offer?.priceCurrency ?? first(offer?.priceSpecification)?.priceCurrency);
    set('availability', typeof offer?.availability === 'string' ? offer.availability.replace(/^https?:\/\/schema\.org\//, '') : undefined);
    rating(n, set);
  } else if (type === 'Offer') {
    set('price', n.price);
    set('currency', n.priceCurrency);
  } else if (type === 'Recipe') {
    set('totalTime', iso(n.totalTime));
    set('yield', n.recipeYield);
    set('calories', first(n.nutrition)?.calories);
    const ing = ([] as unknown[]).concat(n.recipeIngredient ?? []).map(String);
    if (ing.length) f.ingredients = ing.slice(0, 40);
    rating(n, set);
  } else if (/Event$/.test(type)) {
    set('start', n.startDate);
    set('end', n.endDate);
    const loc = first(n.location);
    set('venue', loc?.name);
    set('address', addr(loc?.address));
    set('mode', typeof n.eventAttendanceMode === 'string' ? n.eventAttendanceMode.replace(/^.*\//, '') : undefined);
    const offer = first(n.offers);
    set('price', offer?.price ?? offer?.lowPrice);
    set('currency', offer?.priceCurrency);
  } else if (type === 'JobPosting') {
    set('company', name(n.hiringOrganization));
    set('location', addr(first(n.jobLocation)?.address) ?? n.jobLocationType);
    set('employment', n.employmentType);
    set('posted', n.datePosted);
    set('validThrough', n.validThrough);
    const sal = first(n.baseSalary);
    const v = first(sal?.value);
    set('salary', v ? [v.minValue ?? v.value, v.maxValue].filter((x) => x !== undefined).join('–') + (v.unitText ? `/${String(v.unitText).toLowerCase()}` : '') : undefined);
    set('currency', sal?.currency);
  } else if (/Organization|LocalBusiness|Store|Restaurant|Hotel|Place/.test(type)) {
    set('url', n.url);
    set('telephone', n.telephone);
    set('address', addr(n.address));
    set('sameAs', n.sameAs);
    rating(n, set);
  } else if (/Article|BlogPosting/.test(type)) {
    set('published', n.datePublished);
    set('modified', n.dateModified);
    set('author', name(n.author));
    set('publisher', name(n.publisher));
  } else if (type === 'FAQPage') {
    const qa = ([] as unknown[]).concat(n.mainEntity ?? []).slice(0, 15).map((q) => {
      const qn = q as Node;
      return `Q: ${flat(qn.name)} — A: ${String(flat(first(qn.acceptedAnswer)?.text) ?? '').replace(/<[^>]+>/g, '').slice(0, 300)}`;
    });
    if (qa.length) f.questions = qa;
  } else if (/SoftwareApplication|MobileApplication/.test(type)) {
    set('category', n.applicationCategory);
    set('os', n.operatingSystem);
    const offer = first(n.offers);
    set('price', offer?.price);
    set('currency', offer?.priceCurrency);
    rating(n, set);
  } else {
    set('date', n.datePublished ?? n.uploadDate ?? n.startDate);
    set('author', name(n.author ?? n.creator));
    set('description', typeof n.description === 'string' ? n.description.slice(0, 300) : undefined);
    rating(n, set);
  }
  return f;
}

function rating(n: Node, set: (k: string, v: unknown) => void): void {
  const r = first(n.aggregateRating);
  if (!r) return;
  set('rating', r.ratingValue);
  set('ratingCount', r.reviewCount ?? r.ratingCount);
}

function first(v: unknown): Node | undefined {
  const x = Array.isArray(v) ? v[0] : v;
  return x && typeof x === 'object' ? (x as Node) : undefined;
}

function name(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(name).filter(Boolean).join(', ') || undefined;
  return first(v)?.name as string | undefined;
}

function addr(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  const a = first(v);
  if (!a) return undefined;
  return [a.streetAddress, a.addressLocality, a.addressRegion, a.postalCode, name(a.addressCountry) ?? a.addressCountry]
    .filter((x) => typeof x === 'string' && x).join(', ') || undefined;
}

/** PT1H30M → 1h 30m */
function iso(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/.exec(v);
  if (!m || !(m[1] || m[2] || m[3])) return v;
  return [m[1] && `${m[1]}d`, m[2] && `${m[2]}h`, m[3] && `${m[3]}m`].filter(Boolean).join(' ');
}

function flat(v: unknown): string | number | string[] | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return v.trim();
  if (Array.isArray(v)) {
    const xs = v.map((x) => flat(x)).filter((x) => x !== undefined).map(String);
    return xs.length === 1 ? xs[0] : xs;
  }
  if (typeof v === 'object') return name(v);
  return String(v);
}

/** Markdown block appended to a document so agents see the facts with the text. */
export function renderStructured(items: StructuredItem[]): string {
  if (!items.length) return '';
  const lines = ['## Structured data (schema.org)', ''];
  for (const it of items) {
    lines.push(`**${it.type}**`);
    for (const [k, v] of Object.entries(it.facts)) {
      lines.push(Array.isArray(v) && v.length > 3 ? `- ${k}:\n${v.map((x) => `  - ${x}`).join('\n')}` : `- ${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}
