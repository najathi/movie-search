import { load } from "cheerio";
import type { Element } from "domhandler";

const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml"
      }
    });
    console.log(`Fetched ${url} - Status: ${res.status}`);
    return res;
  } catch (e) {
    console.log(`Failed to fetch ${url}:`, e);
    throw e;
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

function uniqueLinks(links: any[]): any[] {
  const seen = new Set<string>();
  const result: any[] = [];
  for (const link of links) {
    const key = link.url;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(link);
    }
  }
  return result;
}

const MAX_PAGES_PER_YEAR = 4;

function extractLinks(html: string, baseUrl: string, query: string): any[] {
  const $ = load(html);
  const links: any[] = [];
  const baseOrigin = new URL(baseUrl).origin.toLowerCase();
  const normalizedQuery = query.toLowerCase().trim();
  const queryWords = normalizedQuery.split(/\s+/);

  console.log(`Extracting links for query words: ${JSON.stringify(queryWords)}`);

  const foundElements = $("div.f a");
  console.log(`Found ${foundElements.length} elements matching 'div.f a'`);

  foundElements.each((i: number, element: Element) => {
    const href = $(element).attr("href");
    const text = $(element).text().trim();
    if (!href || !text) return;

    const url = normalizeUrl(baseUrl, href);
    if (!url) return;

    const lowerUrl = url.toLowerCase();

    if (!lowerUrl.startsWith(baseOrigin)) return;

    if (lowerUrl.includes("-movies/")) {
      console.log(`Skipping category (plural -movies): ${lowerUrl}`);
      return;
    }

    // Debug strict filter
    if (!lowerUrl.includes("-movie/") && !lowerUrl.includes("-series/")) {
      // Only log if it MIGHT have been a match otherwise
      if (text.toLowerCase().includes(queryWords[0])) {
        console.log(`Skipping non-movie suffix: ${lowerUrl} (Text: ${text})`);
      }
      return;
    }

    const lowerText = text.toLowerCase();
    const matchText = queryWords.every(w => lowerText.includes(w));
    const matchUrl = queryWords.every(w => lowerUrl.includes(w));

    if (matchText || matchUrl) {
      console.log(`MATCH FOUND: ${text} -> ${url}`);
      links.push({ title: text, url });
    } else {
      // verbose log for close misses?
      if (lowerText.includes(queryWords[0])) {
        console.log(`Partial match fail: ${text} (Needs all of: ${queryWords})`);
      }
    }
  });

  return uniqueLinks(links);
}

async function fetchPage(url: string): Promise<string | null> {
  const response = await fetchWithTimeout(url, 15000);
  if (!response.ok) return null;
  return await response.text();
}

const YEAR_RANGE = 2; // Reduced for debug

async function runDebug() {
  const baseUrl = "https://moviesda15.com";
  const query = "Alappuzha Gymkhana";

  const currentYear = new Date().getFullYear();

  const yearsToScan: number[] = [currentYear + 1, currentYear];
  console.log(`Scanning years: ${yearsToScan}`);

  const candidateUrls: string[] = [];

  for (const year of yearsToScan) {
    candidateUrls.push(`${baseUrl}/tamil-${year}-movies/`);
    for (let p = 2; p <= MAX_PAGES_PER_YEAR; p++) {
      candidateUrls.push(`${baseUrl}/tamil-${year}-movies/?page=${p}`);
    }
  }

  console.log(`URLs to scan: ${candidateUrls.length}`);

  const BATCH_SIZE = 2;
  for (let i = 0; i < candidateUrls.length; i += BATCH_SIZE) {
    const batch = candidateUrls.slice(i, i + BATCH_SIZE);
    console.log(`Fetching batch: ${batch}`);
    const results = await Promise.all(
      batch.map(async (url) => {
        try {
          const html = await fetchPage(url);
          if (!html) {
            console.log(`No HTML for ${url}`);
            return [];
          }
          return extractLinks(html, baseUrl, query);
        } catch (e) {
          console.error(`Error processing ${url}`, e);
          return [];
        }
      })
    );
  }
}

runDebug().catch(console.error);
