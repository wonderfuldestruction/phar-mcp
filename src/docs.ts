const DOCS_BASE_URL = "https://docs.phar.gg/";
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_PAGES = 64;
const DEFAULT_PAGE_CHARS = 12_000;
const MAX_PAGE_CHARS = 50_000;

const seedPaths = [
  "/",
  "/pages/x-33",
  "/pages/xphar",
  "/pages/legacy-liquidity",
  "/pages/concentrated-liquidity",
  "/pages/tokenomics",
  "/pages/mev",
  "/pages/audits",
  "/pages/contract-addresses",
  "/pages/design-principles",
  "/pages/disclaimers-and-legal",
  "/pages/BUSL",
  "/pages/intro-to-defi",
  "/pages/onboarding",
  "/pages/swapping",
  "/pages/farming",
  "/pages/voting",
  "/pages/glossary",
  "/pages/mediakit"
] as const;

type FetchResult = {
  url: string;
  status: number;
  html: string;
  fetchedAt: string;
  contentType: string | null;
};

export type DocsPage = {
  title: string;
  url: string;
  path: string;
  text: string;
  fetchedAt: string;
  status: number;
  contentType: string | null;
};

type DocsCache = {
  fetchedAtMs: number;
  fetchedAt: string;
  pages: DocsPage[];
  errors: Array<{ url: string; error: string }>;
};

let cache: DocsCache | undefined;

function cacheTtlMs() {
  const raw = process.env.PHAR_MCP_DOCS_CACHE_TTL_MS;
  if (!raw) return DEFAULT_CACHE_TTL_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_CACHE_TTL_MS;
}

function capPageChars(value?: number) {
  if (value === undefined) return DEFAULT_PAGE_CHARS;
  return Math.max(500, Math.min(MAX_PAGE_CHARS, Math.floor(value)));
}

function canonicalDocsUrl(pathOrUrl: string) {
  const trimmed = pathOrUrl.trim();
  const normalized = trimmed === "" || trimmed === "home"
    ? "/"
    : trimmed.startsWith("http://") || trimmed.startsWith("https://") || trimmed.startsWith("/")
      ? trimmed
      : `/pages/${trimmed}`;
  const url = new URL(normalized, DOCS_BASE_URL);
  if (url.hostname !== "docs.phar.gg") {
    throw new Error(`Only docs.phar.gg URLs are allowed. Received ${url.href}`);
  }
  if (url.pathname !== "/" && !url.pathname.startsWith("/pages/")) {
    throw new Error(`Only docs.phar.gg root or /pages/* docs URLs are allowed. Received ${url.href}`);
  }
  url.protocol = "https:";
  url.hash = "";
  url.search = "";
  return url;
}

function decodeEntities(value: string) {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: "\"",
    rsquo: "'",
    lsquo: "'",
    rdquo: "\"",
    ldquo: "\"",
    mdash: "-",
    ndash: "-",
    hellip: "..."
  };

  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&([a-z]+);/gi, (match, name: string) => named[name] ?? match);
}

function stripHtmlToText(html: string) {
  const withoutNoise = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");

  return decodeEntities(withoutNoise
    .replace(/<(?:h[1-6]|p|li|br|tr|td|th|div|section|article|main|header|footer|table|ul|ol)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function titleFromHtml(html: string, text: string, url: URL) {
  const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
  const rawTitle = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s*\|\s*Docs\s*$/i, "").trim() : "";
  if (rawTitle) return rawTitle;
  const firstLine = text.split("\n").map((line) => line.trim()).find(Boolean);
  return firstLine || (url.pathname === "/" ? "Pharaoh Docs" : url.pathname.split("/").filter(Boolean).at(-1) ?? "Pharaoh Docs");
}

function extractDocsLinks(html: string, sourceUrl: string) {
  const links = new Set<string>();
  for (const match of html.matchAll(/\bhref=(?:"([^"]+)"|'([^']+)')/gi)) {
    const href = match[1] ?? match[2];
    if (!href || href.startsWith("mailto:") || href.startsWith("tel:")) continue;
    try {
      const url = new URL(decodeEntities(href), sourceUrl);
      if (url.hostname !== "docs.phar.gg") continue;
      if (url.pathname !== "/" && !url.pathname.startsWith("/pages/")) continue;
      url.protocol = "https:";
      url.hash = "";
      url.search = "";
      links.add(url.href);
    } catch {
      // Ignore malformed non-doc links.
    }
  }
  return [...links];
}

async function fetchDocsUrl(url: URL): Promise<FetchResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
        "user-agent": "phar-mcp docs reader"
      },
      signal: controller.signal
    });
    const html = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${url.href}`);
    }
    return {
      url: response.url,
      status: response.status,
      html,
      fetchedAt: new Date().toISOString(),
      contentType: response.headers.get("content-type")
    };
  } finally {
    clearTimeout(timeout);
  }
}

function pageFromFetch(fetchResult: FetchResult) {
  const url = canonicalDocsUrl(fetchResult.url);
  const text = stripHtmlToText(fetchResult.html);
  return {
    title: titleFromHtml(fetchResult.html, text, url),
    url: url.href,
    path: url.pathname,
    text,
    fetchedAt: fetchResult.fetchedAt,
    status: fetchResult.status,
    contentType: fetchResult.contentType
  } satisfies DocsPage;
}

function shouldUseCache(refresh?: boolean) {
  if (refresh || !cache) return false;
  const ttl = cacheTtlMs();
  return ttl === 0 || Date.now() - cache.fetchedAtMs <= ttl;
}

async function buildDocsIndex(maxPages = DEFAULT_MAX_PAGES): Promise<DocsCache> {
  const discovered = new Set<string>();
  const queue = seedPaths.map((path) => canonicalDocsUrl(path).href);
  const pages: DocsPage[] = [];
  const errors: Array<{ url: string; error: string }> = [];

  for (let index = 0; index < queue.length && pages.length < maxPages; index += 1) {
    const href = queue[index];
    if (discovered.has(href)) continue;
    discovered.add(href);

    try {
      const fetched = await fetchDocsUrl(new URL(href));
      const page = pageFromFetch(fetched);
      pages.push(page);
      for (const link of extractDocsLinks(fetched.html, page.url)) {
        if (!discovered.has(link) && !queue.includes(link) && queue.length < maxPages * 2) {
          queue.push(link);
        }
      }
    } catch (error) {
      errors.push({ url: href, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return {
    fetchedAtMs: Date.now(),
    fetchedAt: new Date().toISOString(),
    pages: pages.sort((a, b) => a.path.localeCompare(b.path)),
    errors
  };
}

/** @summary Fetch and cache all docs.phar.gg pages, returning page list with titles and URLs */

export async function pharaohDocsIndex(input: { refresh?: boolean; maxPages?: number } = {}) {
  const maxPages = Math.max(1, Math.min(DEFAULT_MAX_PAGES, Math.floor(input.maxPages ?? DEFAULT_MAX_PAGES)));
  if (!shouldUseCache(input.refresh) || (cache?.pages.length ?? 0) < maxPages) {
    cache = await buildDocsIndex(maxPages);
  }
  const activeCache = cache;
  if (!activeCache) {
    throw new Error("Pharaoh docs index cache was not initialized.");
  }

  return {
    source: DOCS_BASE_URL,
    fetchedAt: activeCache.fetchedAt,
    cacheTtlMs: cacheTtlMs(),
    pageCount: activeCache.pages.length,
    errors: activeCache.errors,
    pages: activeCache.pages.map((page) => ({
      title: page.title,
      url: page.url,
      path: page.path,
      fetchedAt: page.fetchedAt,
      textLength: page.text.length
    }))
  };
}

function tokenize(value: string) {
  return [...new Set(value.toLowerCase().match(/[a-z0-9][a-z0-9+.#-]{1,}/g) ?? [])];
}

function countTerm(haystack: string, term: string) {
  let count = 0;
  let offset = 0;
  while (true) {
    const found = haystack.indexOf(term, offset);
    if (found === -1) return count;
    count += 1;
    offset = found + term.length;
  }
}

function scorePage(page: DocsPage, query: string) {
  const terms = tokenize(query);
  if (terms.length === 0) return { score: 1, matchedTerms: [] };
  const lowerTitle = page.title.toLowerCase();
  const lowerText = page.text.toLowerCase();
  const phrase = query.trim().toLowerCase();
  const matchedTerms: string[] = [];
  let score = 0;

  for (const term of terms) {
    const titleHits = countTerm(lowerTitle, term);
    const textHits = countTerm(lowerText, term);
    if (titleHits || textHits) matchedTerms.push(term);
    score += titleHits * 8 + Math.min(textHits, 25);
  }
  if (phrase.length >= 4 && lowerTitle.includes(phrase)) score += 30;
  if (phrase.length >= 4 && lowerText.includes(phrase)) score += 15;

  return { score, matchedTerms };
}

function makeSnippet(text: string, query: string, maxChars: number) {
  const compact = text.replace(/\s+/g, " ").trim();
  const terms = tokenize(query);
  const lower = compact.toLowerCase();
  const phrase = query.trim().toLowerCase();
  let index = phrase.length >= 4 ? lower.indexOf(phrase) : -1;
  if (index === -1) {
    index = terms.map((term) => lower.indexOf(term)).filter((found) => found >= 0).sort((a, b) => a - b)[0] ?? 0;
  }

  const half = Math.floor(maxChars / 2);
  const start = Math.max(0, index - half);
  const end = Math.min(compact.length, start + maxChars);
  const snippet = compact.slice(start, end).trim();
  return `${start > 0 ? "... " : ""}${snippet}${end < compact.length ? " ..." : ""}`;
}

/** @summary Search cached docs.phar.gg pages by query, returning scored results with snippets */

export async function pharaohDocsSearch(input: {
  query: string;
  limit?: number;
  refresh?: boolean;
  maxPages?: number;
  snippetChars?: number;
}) {
  const docsIndex = await pharaohDocsIndex({ refresh: input.refresh, maxPages: input.maxPages });
  const limit = Math.max(1, Math.min(20, Math.floor(input.limit ?? 5)));
  const snippetChars = Math.max(160, Math.min(2_000, Math.floor(input.snippetChars ?? 600)));

  const results = (cache?.pages ?? [])
    .map((page) => ({ page, ...scorePage(page, input.query) }))
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score || a.page.path.localeCompare(b.page.path))
    .slice(0, limit)
    .map((result) => ({
      title: result.page.title,
      url: result.page.url,
      path: result.page.path,
      score: result.score,
      matchedTerms: result.matchedTerms,
      snippet: makeSnippet(result.page.text, input.query, snippetChars),
      fetchedAt: result.page.fetchedAt
    }));

  return {
    source: DOCS_BASE_URL,
    fetchedAt: docsIndex.fetchedAt,
    query: input.query,
    pageCount: docsIndex.pageCount,
    resultCount: results.length,
    results,
    errors: docsIndex.errors,
    usage: "Use pharaoh_docs_page_get with a returned path or url when the full source page is needed for a user answer."
  };
}

/** @summary Fetch or retrieve from cache a specific docs.phar.gg page by path or URL */

export async function pharaohDocsPageGet(input: {
  pathOrUrl?: string;
  refresh?: boolean;
  maxChars?: number;
}) {
  const url = canonicalDocsUrl(input.pathOrUrl ?? "/");
  const maxChars = capPageChars(input.maxChars);

  if (!input.refresh && shouldUseCache(false)) {
    const cached = cache?.pages.find((page) => page.url === url.href || page.path === url.pathname);
    if (cached) {
      return {
        source: DOCS_BASE_URL,
        title: cached.title,
        url: cached.url,
        path: cached.path,
        fetchedAt: cached.fetchedAt,
        status: cached.status,
        contentType: cached.contentType,
        text: cached.text.slice(0, maxChars),
        textLength: cached.text.length,
        truncated: cached.text.length > maxChars
      };
    }
  }

  const fetched = await fetchDocsUrl(url);
  const page = pageFromFetch(fetched);
  return {
    source: DOCS_BASE_URL,
    title: page.title,
    url: page.url,
    path: page.path,
    fetchedAt: page.fetchedAt,
    status: page.status,
    contentType: page.contentType,
    text: page.text.slice(0, maxChars),
    textLength: page.text.length,
    truncated: page.text.length > maxChars
  };
}
