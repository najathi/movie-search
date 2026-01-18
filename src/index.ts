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

function extractLinks(html: string, baseUrl: string): LinkResult[] {
  const $ = load(html);
  const links: LinkResult[] = [];
  const baseOrigin = new URL(baseUrl).origin.toLowerCase();

  $("a").each((_: number, element: Element) => {
    const href = $(element).attr("href");
    const text = $(element).text().trim();
    if (!href) return;

    const url = normalizeUrl(baseUrl, href);
    if (!url) return;

    const lower = url.toLowerCase();
    if (!lower.startsWith(baseOrigin)) return;
    if (!text) return;

    links.push({ title: text, url });
  });

  return uniqueLinks(links);
}

async function trySearch(url: string): Promise<string | null> {
  const response = await fetchWithTimeout(url, 10000);
  if (!response.ok) return null;
  const text = await response.text();
  if (!text || text.length < 200) return null;
  return text;
}

async function searchMovieLinks(params: SearchParams): Promise<LinkResult[]> {
  const baseUrl = params.baseUrl;
  const query = params.query.trim();
  const maxResults = params.maxResults ?? 10;

  const candidates = [
    `${baseUrl}/search/${encodeURIComponent(query)}`,
    `${baseUrl}/?s=${encodeURIComponent(query)}`,
    `${baseUrl}/search?search=${encodeURIComponent(query)}`,
    `${baseUrl}/search?query=${encodeURIComponent(query)}`
  ];

  let html: string | null = null;
  for (const url of candidates) {
    try {
      html = await trySearch(url);
    } catch {
      html = null;
    }
    if (html) break;
  }

  if (!html) return [];

  const links = extractLinks(html, baseUrl)
    .filter((link) => {
      const lower = link.url.toLowerCase();
      return lower.includes("/movie") || lower.includes("/movies") || lower.includes("/movie-") || lower.includes("/tamil");
    })
    .slice(0, maxResults);

  return links;
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
