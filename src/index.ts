import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { load } from "cheerio";
import type { Element } from "domhandler";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

const SearchInput = z.object({
  baseUrl: z.string().url().describe("Movie site base URL, e.g. https://moviesda15.com"),
  query: z.string().min(1, "query is required"),
  maxResults: z.number().int().min(1).max(50).optional()
});

type SearchParams = z.infer<typeof SearchInput>;

type LinkResult = {
  title: string;
  url: string;
};

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml"
      }
    });
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeUrl(baseUrl: string, href: string): string | null {
  try {
    const url = new URL(href, baseUrl);
    return url.toString();
  } catch {
    return null;
  }
}

function uniqueLinks(links: LinkResult[]): LinkResult[] {
  const seen = new Set<string>();
  const result: LinkResult[] = [];
  for (const link of links) {
    const key = link.url;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(link);
    }
  }
  return result;
}

const MAX_PAGES_ABSOLUTE_LIMIT = 50; // Safety cap

function extractLinks(html: string, baseUrl: string, query: string): LinkResult[] {
  const $ = load(html);
  const links: LinkResult[] = [];
  const baseOrigin = new URL(baseUrl).origin.toLowerCase();
  const normalizedQuery = query.toLowerCase().trim();
  const queryWords = normalizedQuery.split(/\s+/);

  // User specified structure for movies: <div class="f"> <a href="..."> ... </a> </div>
  $("div.f a").each((_: number, element: Element) => {
    const href = $(element).attr("href");
    const text = $(element).text().trim();
    if (!href || !text) return;

    const url = normalizeUrl(baseUrl, href);
    if (!url) return;

    const lowerUrl = url.toLowerCase();

    // Strict filter: Must be from the same origin
    if (!lowerUrl.startsWith(baseOrigin)) return;

    // Strict filter: Movie pages end in '-movie/' or '-web-series/' but NOT '-movies/'
    // Example valid: /dhandoraa-2025-tamil-movie/
    // Example invalid: /tamil-2025-movies/
    if (lowerUrl.includes("-movies/")) return;

    // Often valid movie links have specific patterns, but exclusion is safer.
    // If it doesn't have "-movie/" or "-series/", it might be a category or junk.
    // Let's rely on the negative filter for category pages mainly.
    if (!lowerUrl.includes("-movie/") && !lowerUrl.includes("-series/")) return;

    const lowerText = text.toLowerCase();

    // Check if text or URL contains the query
    const matchText = queryWords.every(w => lowerText.includes(w));
    const matchUrl = queryWords.every(w => lowerUrl.includes(w));

    if (matchText || matchUrl) {
      links.push({ title: text, url });
    }
  });

  return uniqueLinks(links);
}

// Helper to find max pages from HTML
function detectMaxPages(html: string): number {
  const $ = load(html);
  let maxPage = 1;
  // Look for pagination links ?page=N or /page/N/
  $("a").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;

    // Match ?page=123
    const matchQuery = href.match(/[?&]page=(\d+)/);
    if (matchQuery) {
      const p = parseInt(matchQuery[1], 10);
      if (!isNaN(p) && p > maxPage) maxPage = p;
    }
  });
  return maxPage;
}

async function fetchPage(url: string): Promise<string | null> {
  const response = await fetchWithTimeout(url, 10000);
  if (!response.ok) return null;
  const text = await response.text();
  if (!text || text.length < 200) return null;
  return text;
}

const YEAR_RANGE = 7; // Look back 7 years

async function searchMovieLinks(params: SearchParams): Promise<LinkResult[]> {
  const baseUrl = params.baseUrl;
  const query = params.query.trim();
  const maxResults = params.maxResults ?? 10;

  const currentYear = new Date().getFullYear();

  // We will scan year pages. For each year, we scan ALL pages.
  const yearsToScan: number[] = [currentYear + 1];
  for (let i = 0; i < YEAR_RANGE; i++) {
    yearsToScan.push(currentYear - i);
  }

  let allLinks: LinkResult[] = [];

  // We should scan years sequentially to find recent stuff first?
  // But to find "earliest release" we might need to scan all years?
  // User wants specific movie. So valid movie could be anywhere.

  // Process years in parallel usually fine, but page scanning is heavy.
  // Let's optimize: Scan years, detect max pages, then batch fetch.

  for (const year of yearsToScan) {
    // 1. Fetch Page 1
    const page1Url = `${baseUrl}/tamil-${year}-movies/`;
    const html1 = await fetchPage(page1Url).catch(() => null);

    if (!html1) continue;

    // Extract from Page 1
    const links1 = extractLinks(html1, baseUrl, query);
    allLinks = allLinks.concat(links1);

    // Detect Max Pages
    let maxPages = detectMaxPages(html1);
    if (maxPages > MAX_PAGES_ABSOLUTE_LIMIT) maxPages = MAX_PAGES_ABSOLUTE_LIMIT;

    if (maxPages > 1) {
      const pageUrls: string[] = [];
      for (let p = 2; p <= maxPages; p++) {
        pageUrls.push(`${baseUrl}/tamil-${year}-movies/?page=${p}`);
      }

      // Fetch remaining pages in batches
      const BATCH_SIZE = 10;
      for (let i = 0; i < pageUrls.length; i += BATCH_SIZE) {
        const batch = pageUrls.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(
          batch.map(async (url) => {
            const h = await fetchPage(url).catch(() => null);
            if (!h) return [];
            return extractLinks(h, baseUrl, query);
          })
        );
        for (const l of results) allLinks = allLinks.concat(l);
      }
    }

    // Optimization: if we have enough results and matching perfect query?
    // But query might be obscure. Let's trying scanning.
  }

  // De-duplicate global results
  allLinks = uniqueLinks(allLinks);

  return allLinks.slice(0, maxResults);
}

const server = new McpServer(
  {
    name: "isaimini3-mcp",
    version: "0.1.0"
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

server.registerTool(
  "search_movie_links",
  {
    description: "Search a movie website for a title and return matching links.",
    inputSchema: SearchInput
  },
  async (params: SearchParams) => {
    const results = await searchMovieLinks(params);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              query: params.query,
              baseUrl: params.baseUrl,
              count: results.length,
              results
            },
            null,
            2
          )
        }
      ]
    };
  });

const transport = new StdioServerTransport();
await server.connect(transport);
