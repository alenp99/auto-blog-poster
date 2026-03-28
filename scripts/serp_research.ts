/**
 * serp_research.ts
 *
 * SERP research module — queries SerpAPI for competitor analysis,
 * fetches top-ranking articles, and uses AI to identify content gaps.
 * Results are cached for 4 days to match the run frequency.
 */

import * as https from "https";
import * as http from "http";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

const CACHE_DIR = path.resolve(__dirname, "..", ".claude", "cache", "serp_results");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Site {
  name: string;
  domain: string;
  niche: string;
  target_keywords: string[];
  [key: string]: any;
}

interface SerpOrganicResult {
  position: number;
  title: string;
  link: string;
  snippet: string;
}

interface PeopleAlsoAsk {
  question: string;
  snippet: string;
}

interface ArticleSummary {
  url: string;
  title: string;
  headings: string[];
  wordCount: number;
}

interface CompetitiveInsights {
  commonKeywords: string[];
  contentGaps: string[];
  avgWordCount: number;
  commonHeadingPatterns: string[];
  dominantContentFormat: string;
}

export interface SerpResearchResult {
  query: string;
  searchedAt: string;
  topResults: SerpOrganicResult[];
  peopleAlsoAsk: PeopleAlsoAsk[];
  relatedSearches: string[];
  topArticleSummaries: ArticleSummary[];
  competitiveInsights: CompetitiveInsights;
}

// A generic AI request function type — caller provides this
export type AiRequestFn = (prompt: string) => Promise<any>;

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    client
      .get(url, { headers: { "User-Agent": "AutoBlogBot/1.0" } }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          httpGet(res.headers.location!).then(resolve).catch(reject);
          return;
        }
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(data));
      })
      .on("error", reject);
  });
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, text) =>
      `\n${"#".repeat(Number(level))} ${text.replace(/<[^>]+>/g, "").trim()}\n`
    )
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "- $1")
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, "$1\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#\d+;/g, "")
    .replace(/\s+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractHeadings(html: string): string[] {
  const headings: string[] = [];
  const regex = /<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const level = match[1];
    const text = match[2].replace(/<[^>]+>/g, "").trim();
    if (text) headings.push(`H${level}: ${text}`);
  }
  return headings;
}

// ---------------------------------------------------------------------------
// Build search queries from site config
// ---------------------------------------------------------------------------

export function buildSearchQueries(site: Site): string[] {
  const year = new Date().getFullYear();
  const queries: string[] = [];

  const primaryKeyword = site.target_keywords[0] || site.niche;
  queries.push(`${primaryKeyword} ${year}`);

  const secondaryKeyword = site.target_keywords[1] || site.niche;
  const modifiers = ["best practices", "guide", "tools", "strategies"];
  const modifier = modifiers[Math.floor(Math.random() * modifiers.length)];
  queries.push(`${secondaryKeyword} ${modifier}`);

  return queries;
}

// ---------------------------------------------------------------------------
// SerpAPI call with caching
// ---------------------------------------------------------------------------

function cacheFilePath(query: string): string {
  const hash = crypto.createHash("sha256").update(query.toLowerCase().trim()).digest("hex").substring(0, 16);
  return path.join(CACHE_DIR, `${hash}.json`);
}

function isCacheValid(filePath: string, ttlDays: number): boolean {
  if (!fs.existsSync(filePath)) return false;
  const stat = fs.statSync(filePath);
  const ageMs = Date.now() - stat.mtimeMs;
  return ageMs < ttlDays * 24 * 60 * 60 * 1000;
}

async function callSerpApi(query: string, apiKey: string): Promise<any> {
  const params = new URLSearchParams({
    engine: "google",
    q: query,
    api_key: apiKey,
    num: "10",
    gl: "au",
    hl: "en",
  });

  const url = `https://serpapi.com/search.json?${params.toString()}`;
  const raw = await httpGet(url);
  return JSON.parse(raw);
}

async function getCachedOrFetchSerp(query: string, apiKey: string): Promise<any> {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }

  const cachePath = cacheFilePath(query);

  if (isCacheValid(cachePath, 4)) {
    console.log(`    [cache hit] SERP results for "${query}"`);
    return JSON.parse(fs.readFileSync(cachePath, "utf-8"));
  }

  console.log(`    [API call] Searching Google for "${query}"`);
  const data = await callSerpApi(query, apiKey);
  fs.writeFileSync(cachePath, JSON.stringify(data, null, 2));
  return data;
}

// ---------------------------------------------------------------------------
// Parse SerpAPI response into structured data
// ---------------------------------------------------------------------------

function parseSerpResponse(data: any): {
  topResults: SerpOrganicResult[];
  peopleAlsoAsk: PeopleAlsoAsk[];
  relatedSearches: string[];
} {
  const topResults: SerpOrganicResult[] = (data.organic_results || [])
    .slice(0, 10)
    .map((r: any) => ({
      position: r.position,
      title: r.title || "",
      link: r.link || "",
      snippet: r.snippet || "",
    }));

  const peopleAlsoAsk: PeopleAlsoAsk[] = (data.related_questions || [])
    .slice(0, 6)
    .map((q: any) => ({
      question: q.question || "",
      snippet: q.snippet || "",
    }));

  const relatedSearches: string[] = (data.related_searches || [])
    .slice(0, 8)
    .map((s: any) => s.query || "")
    .filter(Boolean);

  return { topResults, peopleAlsoAsk, relatedSearches };
}

// ---------------------------------------------------------------------------
// Fetch and analyze top-ranking articles
// ---------------------------------------------------------------------------

const SKIP_DOMAINS = ["youtube.com", "reddit.com", "wikipedia.org", "quora.com", "twitter.com", "x.com", "facebook.com", "linkedin.com"];

function shouldFetchUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return !SKIP_DOMAINS.some((d) => hostname.includes(d));
  } catch {
    return false;
  }
}

async function fetchTopArticles(urls: string[]): Promise<ArticleSummary[]> {
  const blogUrls = urls.filter(shouldFetchUrl).slice(0, 3);
  const summaries: ArticleSummary[] = [];

  for (const url of blogUrls) {
    try {
      const html = await httpGet(url);
      const text = htmlToText(html);
      const headings = extractHeadings(html);
      const wordCount = text.split(/\s+/).length;

      summaries.push({
        url,
        title: headings[0]?.replace(/^H\d:\s*/, "") || url,
        headings,
        wordCount,
      });
    } catch (err: any) {
      console.log(`    [skip] Could not fetch ${url}: ${err.message}`);
    }
  }

  return summaries;
}

// ---------------------------------------------------------------------------
// Use AI to analyze competitors and find content gaps
// ---------------------------------------------------------------------------

async function analyzeCompetitors(
  aiRequest: AiRequestFn,
  query: string,
  topResults: SerpOrganicResult[],
  articles: ArticleSummary[]
): Promise<CompetitiveInsights> {
  const articleDetails = articles
    .map(
      (a) =>
        `URL: ${a.url}\nHeadings: ${a.headings.join(" | ")}\nWord count: ${a.wordCount}`
    )
    .join("\n\n");

  const serpTitles = topResults.map((r) => `${r.position}. "${r.title}" — ${r.snippet}`).join("\n");

  const prompt = `You are an SEO analyst. Analyze these Google search results for the query "${query}" and identify competitive insights.

TOP 10 GOOGLE RESULTS:
${serpTitles}

TOP ARTICLES ANALYZED:
${articleDetails || "No articles could be fetched"}

Respond in this exact JSON format (pure JSON, no markdown):
{
  "commonKeywords": ["keyword1", "keyword2"],
  "contentGaps": ["gap1", "gap2"],
  "avgWordCount": 1500,
  "commonHeadingPatterns": ["pattern1", "pattern2"],
  "dominantContentFormat": "listicle|how-to|guide|comparison|case-study|review"
}

INSTRUCTIONS:
- commonKeywords: 5-8 keywords/phrases that appear across multiple top results
- contentGaps: 3-5 topics or angles that competitors MISS or barely cover (these are opportunities)
- avgWordCount: estimated average word count of the top articles (use analyzed articles if available, otherwise estimate from snippets)
- commonHeadingPatterns: 3-5 H2/H3 heading patterns commonly used (e.g., "What is X", "Benefits of X", "How to X")
- dominantContentFormat: the most common article format among top results`;

  try {
    const result = await aiRequest(prompt);
    // aiRequest may return parsed JSON or a string
    const parsed = typeof result === "string" ? JSON.parse(result) : result;
    return {
      commonKeywords: parsed.commonKeywords || [],
      contentGaps: parsed.contentGaps || [],
      avgWordCount: parsed.avgWordCount || 1500,
      commonHeadingPatterns: parsed.commonHeadingPatterns || [],
      dominantContentFormat: parsed.dominantContentFormat || "guide",
    };
  } catch (err: any) {
    console.log(`    [warn] Competitor analysis failed: ${err.message}`);
    return {
      commonKeywords: [],
      contentGaps: [],
      avgWordCount: 1500,
      commonHeadingPatterns: [],
      dominantContentFormat: "guide",
    };
  }
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

export async function performSerpResearch(
  aiRequest: AiRequestFn,
  site: Site,
  serpApiKey: string
): Promise<SerpResearchResult> {
  const queries = buildSearchQueries(site);
  const primaryQuery = queries[0];

  let allTopResults: SerpOrganicResult[] = [];
  let allPeopleAlsoAsk: PeopleAlsoAsk[] = [];
  let allRelatedSearches: string[] = [];

  for (const query of queries) {
    const rawData = await getCachedOrFetchSerp(query, serpApiKey);
    const parsed = parseSerpResponse(rawData);
    allTopResults.push(...parsed.topResults);
    allPeopleAlsoAsk.push(...parsed.peopleAlsoAsk);
    allRelatedSearches.push(...parsed.relatedSearches);
  }

  // Deduplicate by URL
  const seen = new Set<string>();
  const uniqueResults: SerpOrganicResult[] = [];
  for (const r of allTopResults) {
    if (!seen.has(r.link)) {
      seen.add(r.link);
      uniqueResults.push(r);
    }
  }
  allTopResults = uniqueResults.slice(0, 10);

  const seenQuestions = new Set<string>();
  allPeopleAlsoAsk = allPeopleAlsoAsk.filter((q) => {
    if (seenQuestions.has(q.question)) return false;
    seenQuestions.add(q.question);
    return true;
  });

  allRelatedSearches = [...new Set(allRelatedSearches)];

  // Fetch top-ranking articles
  const articleUrls = allTopResults.map((r) => r.link);
  console.log(`    Fetching top ${Math.min(3, articleUrls.filter(shouldFetchUrl).length)} competitor articles...`);
  const articleSummaries = await fetchTopArticles(articleUrls);

  // Analyze competitors with AI
  console.log(`    Analyzing competitor content with AI...`);
  const competitiveInsights = await analyzeCompetitors(aiRequest, primaryQuery, allTopResults, articleSummaries);

  return {
    query: queries.join(" | "),
    searchedAt: new Date().toISOString(),
    topResults: allTopResults,
    peopleAlsoAsk: allPeopleAlsoAsk,
    relatedSearches: allRelatedSearches,
    topArticleSummaries: articleSummaries,
    competitiveInsights,
  };
}

// ---------------------------------------------------------------------------
// Format SERP data for injection into the content generation prompt
// ---------------------------------------------------------------------------

export function formatSerpForPrompt(serp: SerpResearchResult): string {
  const topResultsStr = serp.topResults
    .map((r) => `${r.position}. "${r.title}" — ${r.snippet}`)
    .join("\n");

  const paaStr = serp.peopleAlsoAsk
    .map((q) => `- ${q.question}`)
    .join("\n");

  const relatedStr = serp.relatedSearches.join(", ");

  const insights = serp.competitiveInsights;
  const articleStr = serp.topArticleSummaries
    .map((a) => `- ${a.title} (${a.wordCount} words) — Headings: ${a.headings.slice(0, 5).join(", ")}`)
    .join("\n");

  return `
SERP RESEARCH — WHAT'S CURRENTLY RANKING ON GOOGLE:
Search queries analyzed: ${serp.query}

Top Google Results:
${topResultsStr}

People Also Ask:
${paaStr || "- None found"}

Related Searches: ${relatedStr || "None found"}

Top Competitor Articles Analyzed:
${articleStr || "- Could not fetch competitor articles"}

Competitive Analysis:
- Average word count of top articles: ${insights.avgWordCount}
- Common heading patterns: ${insights.commonHeadingPatterns.join(", ") || "N/A"}
- Dominant content format: ${insights.dominantContentFormat}
- Common keywords: ${insights.commonKeywords.join(", ") || "N/A"}

CONTENT GAPS (topics NOT covered by competitors — YOUR opportunity to stand out):
${insights.contentGaps.map((g) => `- ${g}`).join("\n") || "- No clear gaps identified"}`;
}
