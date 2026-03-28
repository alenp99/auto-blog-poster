#!/usr/bin/env npx ts-node

/**
 * generate_and_publish_blog.ts
 *
 * Main entry point for the auto blog publisher.
 * 1. Fetches site configs from the dashboard API
 * 2. Crawls each target website to study its style, content, and structure
 * 3. Uses Gemini AI to generate blog posts that match the site
 * 4. Submits posts to the dashboard for review or auto-publish
 *
 * Triggered by: n8n (every 4 days at 8 AM Sydney) → GitHub Actions → this script
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import * as http from "http";
import { performSerpResearch, formatSerpForPrompt, SerpResearchResult, AiRequestFn } from "./serp_research";

const ROOT = path.resolve(__dirname, "..");
const CACHE_DIR = path.join(ROOT, ".claude", "cache");
const OUTPUT_DIR = path.join(ROOT, "output");
const SITE_PROFILES_DIR = path.join(CACHE_DIR, "site_profiles");
const SERP_CACHE_DIR = path.join(CACHE_DIR, "serp_results");
const SITES_FILE = path.join(CACHE_DIR, "sites.json");
const PUBLISHED_FILE = path.join(CACHE_DIR, "published_posts.json");
const TOPIC_IDEAS_FILE = path.join(CACHE_DIR, "topic_ideas.json");
const RESEARCH_FILE = path.join(CACHE_DIR, "research_notes.md");
const IMAGE_PROMPTS_FILE = path.join(CACHE_DIR, "image_prompts.md");

const DASHBOARD_URL = process.env.DASHBOARD_URL || "http://localhost:3000";

interface Site {
  name: string;
  domain: string;
  platform: string;
  content_mode: "mdx" | "api";
  content_path?: string;
  publish_endpoint?: string;
  publish_api_key?: string;
  blog_path?: string;
  niche: string;
  tone: string;
  target_keywords: string[];
  post_length: number;
  auto_publish: boolean;
  publish_method: string;
}

interface PublishedPost {
  site: string;
  topic: string;
  slug: string;
  date: string;
  keywords: string[];
  category: string;
  tags: string[];
  imagePrompt: string;
  outputPath: string;
  publishedUrl: string;
  status: string;
}

interface TopicIdea {
  site: string;
  date: string;
  selected: string;
  rejected: string[];
  reason: string;
}

// ---------------------------------------------------------------------------
// Dashboard API helpers
// ---------------------------------------------------------------------------
function httpRequest(url: string, method: string, body?: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const client = parsedUrl.protocol === "https:" ? https : http;
    const bodyStr = body ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = { "Accept": "application/json" };
    if (bodyStr) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(bodyStr).toString();
    }

    const req = client.request({
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
      method,
      headers,
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function fetchSitesFromDashboard(): Promise<Site[]> {
  try {
    const sites = await httpRequest(`${DASHBOARD_URL}/api/sites`, "GET");
    if (Array.isArray(sites) && sites.length > 0) {
      console.log(`Loaded ${sites.length} site(s) from dashboard`);
      return sites;
    }
  } catch (err: any) {
    console.log(`Dashboard not available (${err.message}), falling back to local sites.json`);
  }
  return [];
}

async function submitPostToDashboard(siteId: string, post: any): Promise<{ id: string; status: string; publishedUrl: string }> {
  return httpRequest(`${DASHBOARD_URL}/api/posts`, "POST", { site_id: siteId, post });
}

interface SiteProfile {
  domain: string;
  scannedAt: string;
  homepage: string;
  blogPosts: string[];
  siteDescription: string;
  contentStyle: string;
  topics: string[];
  headingStructure: string;
  ctaStyle: string;
  brandVoice: string;
}

// ---------------------------------------------------------------------------
// Utility: fetch a URL and return HTML as string
// ---------------------------------------------------------------------------
function fetchUrl(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    client
      .get(url, { headers: { "User-Agent": "AutoBlogBot/1.0" } }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          fetchUrl(res.headers.location).then(resolve).catch(reject);
          return;
        }
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(data));
      })
      .on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Strip HTML to readable text (lightweight, no dependency)
// ---------------------------------------------------------------------------
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "[HEADER]")
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, text) => `\n${"#".repeat(Number(level))} ${text.replace(/<[^>]+>/g, "").trim()}\n`)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "- $1")
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, "$1\n\n")
    .replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)")
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

// ---------------------------------------------------------------------------
// Extract links from HTML
// ---------------------------------------------------------------------------
function extractLinks(html: string, baseUrl: string): string[] {
  const links: string[] = [];
  const regex = /<a[^>]*href="([^"]*)"[^>]*>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    let href = match[1];
    if (href.startsWith("/")) href = baseUrl.replace(/\/$/, "") + href;
    if (href.startsWith(baseUrl)) links.push(href);
  }
  return [...new Set(links)];
}

// ---------------------------------------------------------------------------
// Study a website: crawl homepage + blog pages, build a site profile
// ---------------------------------------------------------------------------
async function studyWebsite(
  genAI: GoogleGenerativeAI,
  site: Site
): Promise<SiteProfile> {
  const profilePath = path.join(SITE_PROFILES_DIR, `${site.name.toLowerCase()}.json`);

  // Check for cached profile (refresh if older than 7 days)
  if (fs.existsSync(profilePath)) {
    const cached: SiteProfile = JSON.parse(fs.readFileSync(profilePath, "utf-8"));
    const age = Date.now() - new Date(cached.scannedAt).getTime();
    if (age < 7 * 24 * 60 * 60 * 1000) {
      console.log(`  Using cached site profile (scanned ${cached.scannedAt})`);
      return cached;
    }
    console.log(`  Cached profile expired, re-scanning...`);
  }

  console.log(`  Crawling ${site.domain}...`);

  // Fetch homepage
  let homepageHtml = "";
  try {
    homepageHtml = await fetchUrl(site.domain);
  } catch (err: any) {
    console.error(`  Failed to fetch homepage: ${err.message}`);
  }

  const homepageText = htmlToText(homepageHtml).substring(0, 5000);

  // Find blog pages
  const blogPath = site.blog_path || "/blog";
  const blogUrl = site.domain.replace(/\/$/, "") + blogPath;
  let blogHtml = "";
  try {
    blogHtml = await fetchUrl(blogUrl);
  } catch (err: any) {
    console.error(`  Failed to fetch blog page: ${err.message}`);
  }

  // Extract blog post links
  const allLinks = extractLinks(blogHtml, site.domain);
  const blogLinks = allLinks.filter(
    (l) => l.includes("/blog/") && l !== blogUrl && !l.endsWith("/blog") && !l.endsWith("/blog/")
  ).slice(0, 5);

  console.log(`  Found ${blogLinks.length} blog post(s) to study`);

  // Fetch up to 3 existing blog posts for style analysis
  const blogPostTexts: string[] = [];
  for (const link of blogLinks.slice(0, 3)) {
    try {
      const postHtml = await fetchUrl(link);
      blogPostTexts.push(htmlToText(postHtml).substring(0, 3000));
    } catch {
      // skip failed fetches
    }
  }

  // Use Gemini to analyze the site
  const model = genAI.getGenerativeModel({
    model: "gemini-2.0-flash",
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 2048,
      responseMimeType: "application/json",
    },
  });

  const analysisPrompt = `Analyze this website and its blog to create a content profile. Study the writing style, tone, topics, structure, and brand voice.

HOMEPAGE CONTENT:
${homepageText}

EXISTING BLOG POSTS (${blogPostTexts.length} samples):
${blogPostTexts.map((t, i) => `--- Post ${i + 1} ---\n${t}`).join("\n\n")}

BLOG POST URLs FOUND:
${blogLinks.join("\n")}

Respond in this exact JSON format:
{
  "siteDescription": "What the company/site does in 2-3 sentences",
  "contentStyle": "How articles are written - paragraph length, use of lists, technical depth, examples style",
  "topics": ["list", "of", "main", "topics", "covered"],
  "headingStructure": "How headings are used - H2/H3 patterns, naming conventions",
  "ctaStyle": "How CTAs are presented - placement, tone, what they promote",
  "brandVoice": "The overall brand voice - formal/casual, authoritative/friendly, technical/accessible, any unique patterns"
}`;

  console.log(`  Analyzing site with Gemini...`);
  let analysis: any;
  try {
    const result = await model.generateContent(analysisPrompt);
    analysis = JSON.parse(result.response.text());
  } catch (err: any) {
    console.error(`  Site analysis failed: ${err.message}`);
    analysis = {
      siteDescription: site.niche,
      contentStyle: "Professional blog format with clear sections",
      topics: site.target_keywords,
      headingStructure: "H2 for main sections, H3 for subsections",
      ctaStyle: "End-of-article CTA",
      brandVoice: site.tone,
    };
  }

  const profile: SiteProfile = {
    domain: site.domain,
    scannedAt: new Date().toISOString(),
    homepage: homepageText.substring(0, 2000),
    blogPosts: blogLinks,
    siteDescription: analysis.siteDescription,
    contentStyle: analysis.contentStyle,
    topics: analysis.topics,
    headingStructure: analysis.headingStructure,
    ctaStyle: analysis.ctaStyle,
    brandVoice: analysis.brandVoice,
  };

  // Cache the profile
  fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2));
  console.log(`  Site profile saved to cache`);

  return profile;
}

// ---------------------------------------------------------------------------
// Publish to blog API
// ---------------------------------------------------------------------------
async function publishToApi(
  site: Site,
  payload: object
): Promise<{ success: boolean; url?: string; error?: string }> {
  if (!site.publish_endpoint) {
    return { success: false, error: "No publish_endpoint configured" };
  }

  const body = JSON.stringify(payload);
  const url = new URL(site.publish_endpoint);

  return new Promise((resolve) => {
    const client = url.protocol === "https:" ? https : http;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body).toString(),
    };

    // Add API key auth if configured
    if (site.publish_api_key) {
      const apiKey = process.env[site.publish_api_key] || site.publish_api_key;
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const req = client.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: "POST",
        headers,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            let postUrl = "";
            try {
              const parsed = JSON.parse(data);
              postUrl = parsed.url || parsed.slug || parsed.id || "";
            } catch {}
            resolve({ success: true, url: postUrl });
          } else {
            resolve({
              success: false,
              error: `HTTP ${res.statusCode}: ${data.substring(0, 200)}`,
            });
          }
        });
      }
    );

    req.on("error", (err) => {
      resolve({ success: false, error: err.message });
    });

    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------
function ensureDirectories(sites: Site[]) {
  const dirs = [CACHE_DIR, SITE_PROFILES_DIR, SERP_CACHE_DIR, path.join(OUTPUT_DIR, "api_payloads")];
  for (const site of sites) {
    if (site.content_mode === "mdx" && site.content_path) {
      dirs.push(path.join(ROOT, site.content_path));
    }
  }
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

function ensureCacheFiles() {
  const defaults: Record<string, string> = {
    [PUBLISHED_FILE]: "[]",
    [TOPIC_IDEAS_FILE]: "[]",
    [RESEARCH_FILE]: "# Research Notes\n",
    [IMAGE_PROMPTS_FILE]: "# Featured Image Prompts\n",
  };
  for (const [filePath, defaultContent] of Object.entries(defaults)) {
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, defaultContent);
    }
  }
}

function loadPublishedPosts(): PublishedPost[] {
  if (!fs.existsSync(PUBLISHED_FILE)) return [];
  return JSON.parse(fs.readFileSync(PUBLISHED_FILE, "utf-8"));
}

function loadTopicIdeas(): TopicIdea[] {
  if (!fs.existsSync(TOPIC_IDEAS_FILE)) return [];
  return JSON.parse(fs.readFileSync(TOPIC_IDEAS_FILE, "utf-8"));
}

// ---------------------------------------------------------------------------
// Build the Gemini prompt using the site profile
// ---------------------------------------------------------------------------
function buildPromptForSite(
  site: Site,
  profile: SiteProfile,
  publishedPosts: PublishedPost[],
  topicIdeas: TopicIdea[],
  serpData?: SerpResearchResult | null
): string {
  const sitePosts = publishedPosts.filter((p) => p.site === site.name);
  const publishedTopics = sitePosts.map((p) => p.topic);
  const previousIdeas = topicIdeas
    .filter((t) => t.site === site.name)
    .flatMap((t) => [t.selected, ...t.rejected]);

  const today = new Date().toISOString().split("T")[0];

  return `You are writing a blog post for ${site.name} (${site.domain}). The post must comply with Google's Helpful Content guidelines and E-E-A-T standards. It must be people-first content that genuinely helps readers — NOT content made to manipulate search rankings.

ABOUT THE COMPANY:
- ${profile.siteDescription}
- Brand Voice: ${profile.brandVoice}
- Niche: ${site.niche}
- Tone: ${site.tone}

EXISTING CONTENT: ${profile.blogPosts.length > 0 ? profile.blogPosts.map((url) => `\n- ${url}`).join("") : "\n- None yet"}

DO NOT REPEAT: ${publishedTopics.length > 0 ? publishedTopics.map((t) => `\n- ${t}`).join("") : "\n- None yet"}

PREVIOUSLY CONSIDERED: ${previousIdeas.length > 0 ? previousIdeas.map((t) => `\n- ${t}`).join("") : "\n- None yet"}
${serpData ? formatSerpForPrompt(serpData) : ""}
TOPIC SELECTION:
1. Propose 3 topic ideas. Avoid anything already published or considered.
2. Pick the one where ${site.name} can share genuine EXPERTISE — a topic the company would naturally know about from doing this work, not a generic overview anyone could write.
3. The topic should answer a specific question or solve a specific problem a real customer would have.

GOOGLE E-E-A-T COMPLIANCE — THIS IS CRITICAL:

Experience: Write from the perspective of ${site.name}'s team who actually builds and deploys these solutions. Use phrases like "In our experience working with clients...", "What we've seen across dozens of implementations...", "A pattern we notice with businesses in this space...". This demonstrates first-hand experience.

Expertise: Show deep knowledge. Don't just define terms — explain WHY things work that way, common MISTAKES people make, and NUANCES that only someone with hands-on experience would know. Include specific technical details where relevant.

Authoritativeness: Only reference statistics and claims you are CONFIDENT are real and widely cited. If you're not 100% sure a stat is accurate, don't include it — instead share an observation or insight. When linking to sources, only use:
- Official company homepages (e.g., https://www.intercom.com, https://www.zendesk.com)
- Well-known publication domains (e.g., https://hbr.org, https://www.mckinsey.com, https://www.gartner.com)
- DO NOT fabricate specific report URLs or article paths. Link to the homepage or a known section.

Trustworthiness: Be honest about limitations. Mention when AI is NOT the right solution. Acknowledge trade-offs. This builds trust far more than pure hype.

CONTENT STRUCTURE:
- Open with a real problem or question that ${site.name}'s clients actually face
- Share genuine insights from working in this space — not generic definitions
- Include practical, actionable advice with specific steps
- End with "## Frequently Asked Questions" — 4-5 questions as ### subheadings with concise answers
- Final paragraph: CTA linking to ${site.domain}/contact

LINKING REQUIREMENTS — THIS IS CRITICAL FOR SEO:
You MUST include at least 8 links total in the article. This is non-negotiable.

External links (at least 5): Link to well-known companies, tools, and publications by name.
Use their homepage URLs. Examples of good links:
- [HubSpot](https://www.hubspot.com) when mentioning CRM or marketing
- [Salesforce](https://www.salesforce.com) when mentioning enterprise CRM
- [McKinsey](https://www.mckinsey.com) when referencing consulting insights
- [Gartner](https://www.gartner.com) when referencing industry research
- [Intercom](https://www.intercom.com) when mentioning chat tools
- [Zendesk](https://www.zendesk.com) when mentioning support platforms
- [Harvard Business Review](https://hbr.org) when referencing business strategy
- [Slack](https://slack.com), [Zapier](https://zapier.com), [Notion](https://www.notion.so) for productivity tools
Pick tools and sources that are actually relevant to the topic. Use the company/tool name as anchor text, never "click here" or "learn more".

Internal links (at least 2-3): Link back to ${site.domain} pages naturally within the content.
- Link to [${site.name}](${site.domain}) when mentioning the company
- Link to [our AI automation services](${site.domain}/#services) when discussing solutions
- Link to [our voice agent solutions](${site.domain}/#services) when relevant
- Link to [contact us](${site.domain}/contact) in the CTA
- Link to existing blog posts: ${profile.blogPosts.slice(0, 3).map((url) => url).join(", ")}
Spread internal links naturally throughout the article, not just at the end.

WRITING RULES:
- Write like a knowledgeable person talking to a colleague. Natural, clear, direct.
- Short paragraphs (2-3 sentences max). Short sentences.
- Use ## for main sections (5-6 sections). Use ### for subsections.
- Every section must add value a reader can't get from the top 3 Google results.
- NO filler phrases. NO "In today's world..." or "It's important to note that...".
- BANNED: revolutionize, transform, leverage, cutting-edge, game-changer, unlock, streamline, robust, seamless, landscape, delve, comprehensive, navigate.
- DO NOT start the title with "How" or "The Ultimate Guide".
- DO NOT make up statistics. If you include a number, it must be a widely known, verifiable fact.
- For links: always use the homepage URL of the company/tool (e.g., https://www.intercom.com). Do not guess specific article or report paths.
- Target length: ${site.post_length}+ words of substance.
${serpData ? `
SERP CONTEXT — use to find unique angles, not to copy:
- People Also Ask questions → address these naturally in your FAQ
- Content gaps → pick a gap competitors missed and make it your unique angle
- Competitor avg word count: ${serpData.competitiveInsights.avgWordCount} → meet or exceed
- Add value competitors don't: share practitioner perspective, common pitfalls, honest trade-offs` : ""}

RESPOND IN EXACTLY THIS JSON FORMAT (pure JSON, no markdown wrapping):
{
  "topicIdeas": {
    "selected": "The chosen topic",
    "rejected": ["Alternative 1", "Alternative 2"],
    "reason": "Why this was selected — what unique value does ${site.name} bring to this topic?"
  },
  "post": {
    "title": "Clear, specific title (under 60 chars, naturally includes primary keyword)",
    "slug": "keyword-rich-slug",
    "metaTitle": "Meta title (60 chars max)",
    "metaDescription": "150-155 chars, specific benefit to reader, includes keyword",
    "excerpt": "1-2 sentences — the specific problem this post solves",
    "category": "Main category",
    "tags": ["tag1", "tag2", "tag3", "tag4", "tag5"],
    "outline": ["H2: Section", "H3: Subsection"],
    "content": "Full article in markdown. People-first, E-E-A-T compliant. MUST end with '## Frequently Asked Questions' with 4-5 ### question subheadings and answers, then a CTA paragraph.",
    "imagePrompt": "Professional image for this topic. Specific scene, setting, mood. NO text in image.",
    "socialSnippets": {
      "linkedin": "LinkedIn post (2-3 sentences, value-first)",
      "twitter": "Tweet (under 280 chars)"
    }
  }
}`;
}

// ---------------------------------------------------------------------------
// Convert markdown to styled HTML with collapsible FAQ
// ---------------------------------------------------------------------------
function markdownToHtml(md: string): string {
  if (!md) return "";

  // Split into lines for processing
  const lines = md.split("\n");
  const output: string[] = [];
  let inList: false | "ul" | "ol" = false;
  let inFaqSection = false;
  let faqItems: { q: string; a: string }[] = [];
  let currentFaqQ = "";
  let currentFaqA: string[] = [];

  function flushList() {
    if (inList) { output.push(inList === "ol" ? "</ol>" : "</ul>"); inList = false; }
  }

  function flushFaq() {
    if (currentFaqQ) {
      faqItems.push({ q: currentFaqQ, a: currentFaqA.join(" ").trim() });
      currentFaqQ = "";
      currentFaqA = [];
    }
  }

  function renderFaqSection() {
    if (faqItems.length === 0) return;
    output.push(`<div style="margin-top:2.5rem;margin-bottom:2rem;">`);
    output.push(`<h2 style="font-size:1.5rem;font-weight:700;margin:2.5rem 0 1rem;padding-bottom:0.5rem;border-bottom:1px solid currentColor;opacity:0.9">Frequently Asked Questions</h2>`);
    for (const item of faqItems) {
      output.push(`<details style="margin-bottom:0.75rem;border:1px solid rgba(255,255,255,0.15);border-radius:8px;overflow:hidden;">`);
      output.push(`<summary style="padding:1rem 1.25rem;font-weight:600;font-size:1.05rem;cursor:pointer;background:rgba(255,255,255,0.05);list-style:none;display:flex;justify-content:space-between;align-items:center;">${item.q}<span style="font-size:1.25rem;opacity:0.5;transition:transform 0.2s;">+</span></summary>`);
      output.push(`<div style="padding:0.75rem 1.25rem 1rem;line-height:1.8;opacity:0.85;font-size:1.05rem;">${item.a}</div>`);
      output.push(`</details>`);
    }
    output.push(`</div>`);
    faqItems = [];
    inFaqSection = false;
  }

  function processInline(text: string): string {
    return text
      .replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>")
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) { flushList(); continue; }

    // Detect FAQ section
    if (/^#{1,3}\s*.*(FAQ|Frequently Asked)/i.test(trimmed)) {
      flushList();
      inFaqSection = true;
      continue;
    }

    // Inside FAQ section: collect Q&A pairs
    if (inFaqSection) {
      // Sub-heading = new question
      if (/^#{3,4}\s+/.test(trimmed)) {
        flushFaq();
        currentFaqQ = processInline(trimmed.replace(/^#{1,4}\s+/, ""));
        continue;
      }
      // Major heading = FAQ section ends, new section starts
      if (/^#{1,2}\s+/.test(trimmed) && !/FAQ|Frequently/i.test(trimmed)) {
        flushFaq();
        renderFaqSection();
        // Fall through to process this line as a normal heading below
      } else {
        // Everything else is part of the current answer
        const text = trimmed.startsWith("- ") || trimmed.startsWith("* ")
          ? processInline(trimmed.replace(/^[-*]\s+/, ""))
          : processInline(trimmed);
        currentFaqA.push(text);
        continue;
      }
    }

    // H1 — skip, the page already renders the title as H1
    if (trimmed.startsWith("# ") && !trimmed.startsWith("## ")) {
      flushList();
      continue;
    }

    // H2 — matches site's existing style
    if (trimmed.startsWith("## ") && !trimmed.startsWith("### ")) {
      flushList();
      const text = processInline(trimmed.replace(/^## /, ""));
      output.push(`<h2 style="font-size:1.5rem;font-weight:700;margin:2.5rem 0 1rem;padding-bottom:0.5rem;border-bottom:1px solid currentColor;opacity:0.9">${text}</h2>`);
      continue;
    }

    // H3 — matches site's existing style
    if (trimmed.startsWith("### ")) {
      flushList();
      const text = processInline(trimmed.replace(/^### /, ""));
      output.push(`<h3 style="font-size:1.2rem;font-weight:700;margin:2rem 0 0.75rem">${text}</h3>`);
      continue;
    }

    // List items
    if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      if (!inList) { output.push('<ul style="margin:1rem 0 1.5rem 1.25rem;line-height:1.8">'); inList = "ul"; }
      const text = processInline(trimmed.replace(/^[-*]\s+/, ""));
      output.push(`<li style="margin-bottom:0.5rem">${text}</li>`);
      continue;
    }

    // Numbered list
    if (/^\d+\.\s/.test(trimmed)) {
      if (!inList) { output.push('<ol style="margin:1rem 0 1.5rem 1.25rem;line-height:1.8">'); inList = "ol"; }
      const text = processInline(trimmed.replace(/^\d+\.\s+/, ""));
      output.push(`<li style="margin-bottom:0.5rem">${text}</li>`);
      continue;
    }

    // Regular paragraph — matches site's existing style
    flushList();
    const text = processInline(trimmed);
    output.push(`<p style="margin-bottom:1.25rem;line-height:1.9;font-size:1.05rem">${text}</p>`);
  }

  flushList();
  if (inFaqSection) { flushFaq(); renderFaqSection(); }

  return output.join("\n");
}

// ---------------------------------------------------------------------------
// Inject backlinks into HTML content (post-processing)
// ---------------------------------------------------------------------------
function injectBacklinks(html: string, site: Site, blogPosts: string[]): string {
  // Map of keywords to external links — only inject if the keyword appears naturally
  // Ordered by priority — most specific matches first
  const externalLinks: [string, { url: string; replace: string }][] = [
    // Specific tool/company names
    ["Salesforce", { url: "https://www.salesforce.com", replace: "Salesforce" }],
    ["HubSpot", { url: "https://www.hubspot.com", replace: "HubSpot" }],
    ["Gartner", { url: "https://www.gartner.com", replace: "Gartner" }],
    ["McKinsey", { url: "https://www.mckinsey.com", replace: "McKinsey" }],
    ["Forrester", { url: "https://www.forrester.com", replace: "Forrester" }],
    ["Intercom", { url: "https://www.intercom.com", replace: "Intercom" }],
    ["Zendesk", { url: "https://www.zendesk.com", replace: "Zendesk" }],
    ["Zapier", { url: "https://zapier.com", replace: "Zapier" }],
    ["Slack", { url: "https://slack.com", replace: "Slack" }],
    // Generic terms — match these in content and add a contextual link
    ["chatbot", { url: "https://www.intercom.com", replace: "chatbot" }],
    ["chatbots", { url: "https://www.intercom.com", replace: "chatbots" }],
    ["customer support", { url: "https://www.zendesk.com", replace: "customer support" }],
    ["customer service", { url: "https://www.zendesk.com", replace: "customer service" }],
    ["data analytics", { url: "https://www.tableau.com", replace: "data analytics" }],
    ["analytics tools", { url: "https://www.tableau.com", replace: "analytics tools" }],
    ["analytics", { url: "https://www.tableau.com", replace: "analytics" }],
    ["workflow automation", { url: "https://zapier.com", replace: "workflow automation" }],
    ["automate repetitive", { url: "https://zapier.com", replace: "automate repetitive" }],
    ["automation tools", { url: "https://zapier.com", replace: "automation tools" }],
    ["machine learning", { url: "https://cloud.google.com/ai-platform", replace: "machine learning" }],
    ["AI models", { url: "https://openai.com", replace: "AI models" }],
    ["large language model", { url: "https://openai.com", replace: "large language model" }],
    ["cloud infrastructure", { url: "https://aws.amazon.com", replace: "cloud infrastructure" }],
    ["CRM", { url: "https://www.salesforce.com", replace: "CRM" }],
    ["ROI", { url: "https://hbr.org", replace: "ROI" }],
    ["return on investment", { url: "https://hbr.org", replace: "return on investment" }],
    // Internal — voice/AI agent mentions link to Synthera services
    ["voice agent", { url: "https://www.synthera.com.au/#services", replace: "voice agent" }],
    ["voice agents", { url: "https://www.synthera.com.au/#services", replace: "voice agents" }],
    ["AI agent", { url: "https://www.synthera.com.au/#services", replace: "AI agent" }],
    ["AI agents", { url: "https://www.synthera.com.au/#services", replace: "AI agents" }],
    ["AI automation", { url: "https://www.synthera.com.au", replace: "AI automation" }],
  ];

  // Track which domains we've already linked to avoid duplicates
  const linkedDomains = new Set<string>();
  // Find existing links in content
  const existingLinks = html.match(/href="([^"]+)"/g) || [];
  for (const link of existingLinks) {
    try {
      const url = link.replace(/href="([^"]+)"/, "$1");
      linkedDomains.add(new URL(url).hostname);
    } catch {}
  }

  let injectedExternal = 0;
  let injectedInternal = 0;

  // Inject links — find keywords in paragraph/list text and link first occurrence
  for (const [keyword, { url, replace }] of externalLinks) {
    if (injectedExternal >= 6 && !url.includes("synthera")) continue;
    if (injectedInternal >= 3 && url.includes("synthera")) continue;

    try {
      const hostname = new URL(url).hostname;
      if (linkedDomains.has(hostname)) continue;
    } catch {}

    // Match inside <p> or <li> tags, case-insensitive, first occurrence only
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(
      `(<(?:p|li)[^>]*>(?:(?!</(?:p|li)>).)*)\\b(${escaped})\\b`,
      "i"
    );
    const match = html.match(regex);
    if (match) {
      // Make sure we're not already inside an <a> tag
      const beforeMatch = match[1];
      const lastOpenA = beforeMatch.lastIndexOf("<a ");
      const lastCloseA = beforeMatch.lastIndexOf("</a>");
      if (lastOpenA > lastCloseA) continue; // inside an existing link

      const isInternal = url.includes("synthera");
      const linkHtml = `<a href="${url}" target="_blank" rel="noopener noreferrer">${match[2]}</a>`;
      html = html.replace(match[0], match[1] + linkHtml);
      try { linkedDomains.add(new URL(url).hostname); } catch {}
      if (isInternal) injectedInternal++;
      else injectedExternal++;
    }
  }

  // Ensure at least 2 internal links exist — add service link if missing
  const internalCount = (html.match(/href="[^"]*synthera[^"]*"/g) || []).length;
  if (internalCount < 2) {
    // Add a services link after the first <h2> section
    const firstH2End = html.indexOf("</h2>");
    if (firstH2End > -1) {
      const nextP = html.indexOf("<p", firstH2End);
      if (nextP > -1) {
        const insertPoint = html.indexOf(">", nextP) + 1;
        const prefix = html.substring(insertPoint, insertPoint + 50);
        if (!prefix.includes("synthera")) {
          html = html.substring(0, insertPoint) +
            `At <a href="${site.domain}" target="_blank" rel="noopener noreferrer">${site.name}</a>, we work with businesses to address exactly these kinds of challenges. ` +
            html.substring(insertPoint);
        }
      }
    }
  }

  // Add an internal blog post link if we have existing posts
  if (blogPosts.length > 0 && internalCount < 3) {
    const randomPost = blogPosts[Math.floor(Math.random() * Math.min(blogPosts.length, 5))];
    const slug = randomPost.split("/").pop() || "";
    const readableTitle = slug.replace(/-/g, " ");
    // Insert before the FAQ section or before the last paragraph
    const faqIdx = html.indexOf("Frequently Asked Questions");
    const insertBefore = faqIdx > -1 ? html.lastIndexOf("<p", faqIdx) : html.lastIndexOf("<p");
    if (insertBefore > -1) {
      const relatedLink = `<p style="margin-bottom:1.25rem;line-height:1.9;font-size:1.05rem">For more insights, see our related post on <a href="${randomPost}" target="_blank" rel="noopener noreferrer">${readableTitle}</a>.</p>\n`;
      html = html.substring(0, insertBefore) + relatedLink + html.substring(insertBefore);
    }
  }

  return html;
}

// ---------------------------------------------------------------------------
// Generate image with DALL-E 3 or fallback to Unsplash
// ---------------------------------------------------------------------------
function generateImageDalle(apiKey: string, prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: "dall-e-3",
      prompt: prompt + " — Style: clean, professional, modern. NO text or words in the image.",
      n: 1,
      size: "1792x1024",
    });

    const req = https.request(
      {
        hostname: "api.openai.com",
        path: "/v1/images/generations",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            const url = parsed?.data?.[0]?.url;
            if (url) resolve(url);
            else reject(new Error(`DALL-E error: ${data.substring(0, 200)}`));
          } catch {
            reject(new Error("DALL-E parse error"));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function getUnsplashImage(query: string): string {
  const encoded = encodeURIComponent(query);
  return `https://images.unsplash.com/photo-1677442136019-21780ecad995?w=1200&q=80&fit=crop`;
}

// ---------------------------------------------------------------------------
// Generate content and publish for a single site
// ---------------------------------------------------------------------------
async function processSite(
  genAI: GoogleGenerativeAI,
  site: Site,
  profile: SiteProfile,
  publishedPosts: PublishedPost[],
  topicIdeas: TopicIdea[],
  serpData?: SerpResearchResult | null
): Promise<{
  post: PublishedPost;
  topicIdea: TopicIdea;
  imageEntry: string;
} | null> {
  const today = new Date().toISOString().split("T")[0];

  const prompt = buildPromptForSite(site, profile, publishedPosts, topicIdeas, serpData);

  const model = genAI.getGenerativeModel({
    model: "gemini-2.0-flash",
    generationConfig: {
      temperature: 0.8,
      maxOutputTokens: 8192,
      responseMimeType: "application/json",
    },
  });

  console.log(`  Generating content with Gemini...`);

  let result;
  try {
    result = await model.generateContent(prompt);
  } catch (err: any) {
    console.error(`  Gemini API error: ${err.message}`);
    return null;
  }

  const responseText = result.response.text();
  let parsed: any;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      parsed = JSON.parse(jsonMatch[1].trim());
    } else {
      console.error(`  Failed to parse Gemini response`);
      console.error("  Raw:", responseText.substring(0, 300));
      return null;
    }
  }

  const post = parsed.post;
  const ideas = parsed.topicIdeas;

  console.log(`  Topic: "${ideas.selected}"`);
  console.log(`  Reason: ${ideas.reason}`);

  // Convert markdown to HTML and inject backlinks
  let htmlContent = markdownToHtml(post.content);
  htmlContent = injectBacklinks(htmlContent, site, profile.blogPosts);
  console.log(`  Converted markdown to HTML with backlinks (${htmlContent.length} chars)`);

  // Generate featured image
  let imageUrl = "";
  const openaiKeyForImage = process.env.OPENAI_API_KEY;
  if (openaiKeyForImage && post.imagePrompt) {
    console.log(`  Generating featured image with DALL-E 3...`);
    try {
      imageUrl = await generateImageDalle(openaiKeyForImage, post.imagePrompt);
      console.log(`  Image generated: ${imageUrl.substring(0, 80)}...`);
    } catch (err: any) {
      console.log(`  DALL-E failed (${err.message}), using fallback image`);
      imageUrl = getUnsplashImage(site.niche);
    }
  } else {
    imageUrl = getUnsplashImage(site.niche);
  }

  // Build API payload with HTML content and image
  const apiPayload: Record<string, any> = {
    title: post.title,
    slug: post.slug,
    meta_title: post.metaTitle,
    meta_description: post.metaDescription,
    excerpt: post.excerpt,
    content: htmlContent,
    category: post.category,
    tags: post.tags,
    image_url: imageUrl,
    image_alt: post.title,
    date: today,
    author_name: `${site.name} Team`,
    status: site.auto_publish ? "published" : "draft",
  };

  // Save payload locally as backup
  const payloadFileName = `${site.name.toLowerCase()}_${post.slug}.json`;
  const payloadPath = path.join(ROOT, "output", "api_payloads", payloadFileName);
  fs.writeFileSync(payloadPath, JSON.stringify(apiPayload, null, 2));
  console.log(`  Payload saved: output/api_payloads/${payloadFileName}`);

  let outputPath = `output/api_payloads/${payloadFileName}`;
  let publishedUrl = "";
  let status = "draft";

  // Submit to dashboard — it handles review vs auto-publish
  const siteId = (site as any).id;
  if (siteId) {
    console.log(`  Submitting to dashboard...`);
    try {
      const dashResult = await submitPostToDashboard(siteId, post);
      status = dashResult.status;
      publishedUrl = dashResult.publishedUrl || "";
      if (status === "published") {
        console.log(`  Auto-published: ${publishedUrl}`);
      } else if (status === "pending_review") {
        console.log(`  Held for review on dashboard (first-time site)`);
      }
    } catch (err: any) {
      console.log(`  Dashboard submit failed (${err.message}), falling back to direct publish`);
      // Fallback: publish directly if dashboard is unavailable
      if (site.publish_endpoint && site.auto_publish) {
        const publishResult = await publishToApi(site, apiPayload);
        if (publishResult.success) {
          status = "published";
          publishedUrl = publishResult.url || `${site.domain}/blog/${post.slug}`;
        } else {
          status = "publish_failed";
        }
      }
    }
  } else {
    // No dashboard ID, publish directly
    if (site.publish_endpoint && site.auto_publish) {
      console.log(`  Publishing directly to ${site.publish_endpoint}...`);
      const publishResult = await publishToApi(site, apiPayload);
      if (publishResult.success) {
        status = "published";
        publishedUrl = publishResult.url || `${site.domain}/blog/${post.slug}`;
        console.log(`  Published: ${publishedUrl}`);
      } else {
        status = "publish_failed";
        console.error(`  Publish failed: ${publishResult.error}`);
      }
    }
  }

  const publishedPost: PublishedPost = {
    site: site.name,
    topic: post.title,
    slug: post.slug,
    date: today,
    keywords: site.target_keywords,
    category: post.category,
    tags: post.tags,
    imagePrompt: post.imagePrompt,
    outputPath,
    publishedUrl,
    status,
  };

  const topicIdea: TopicIdea = {
    site: site.name,
    date: today,
    selected: ideas.selected,
    rejected: ideas.rejected,
    reason: ideas.reason,
  };

  const imageEntry = `\n## ${site.name} — ${today}\n**Topic:** ${post.title}\n**Prompt:** ${post.imagePrompt}\n`;

  return { post: publishedPost, topicIdea, imageEntry };
}

// ---------------------------------------------------------------------------
// OpenAI API helpers (native https, no dependency)
// ---------------------------------------------------------------------------

// Creates a wrapper that mimics the GoogleGenerativeAI interface using OpenAI
function createOpenAICompatWrapper(apiKey: string): any {
  return {
    getGenerativeModel(config: any) {
      const temp = config?.generationConfig?.temperature ?? 0.7;
      const maxTokens = config?.generationConfig?.maxOutputTokens ?? 4096;
      const isJson = config?.generationConfig?.responseMimeType === "application/json";
      return {
        async generateContent(prompt: string) {
          const result = await openaiRequest(apiKey, prompt, isJson, temp, maxTokens);
          const text = typeof result === "string" ? result : JSON.stringify(result);
          return {
            response: {
              text() { return text; },
            },
          };
        },
      };
    },
  };
}

function openaiRequest(apiKey: string, prompt: string, jsonMode = false, temperature = 0.7, maxTokens = 4096): Promise<any> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature,
      max_tokens: maxTokens,
      ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
    });

    const req = https.request(
      {
        hostname: "api.openai.com",
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) {
              reject(new Error(`OpenAI API error: ${parsed.error.message}`));
              return;
            }
            const content = parsed.choices?.[0]?.message?.content || "";
            try {
              resolve(JSON.parse(content));
            } catch {
              resolve(content);
            }
          } catch (e: any) {
            reject(new Error(`OpenAI parse error: ${data.substring(0, 300)}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log("=== Auto Blog Publisher ===");
  console.log(`Run started: ${new Date().toISOString()}\n`);

  // AI provider: prefer OpenAI, fallback to Gemini
  const openaiKey = process.env.OPENAI_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;

  if (!openaiKey && !geminiKey) {
    console.error("Error: Neither OPENAI_API_KEY nor GEMINI_API_KEY is set.");
    process.exit(1);
  }

  const aiProvider = openaiKey ? "OpenAI" : "Gemini";
  console.log(`AI Provider: ${aiProvider}`);

  // Create a generic AI request function for SERP analysis
  let aiRequestFn: AiRequestFn;
  let genAI: GoogleGenerativeAI | null = null;

  if (openaiKey) {
    aiRequestFn = (prompt: string) => openaiRequest(openaiKey, prompt, true);
  } else {
    genAI = new GoogleGenerativeAI(geminiKey!);
    aiRequestFn = async (prompt: string) => {
      const model = genAI!.getGenerativeModel({
        model: "gemini-2.0-flash",
        generationConfig: { temperature: 0.3, maxOutputTokens: 2048, responseMimeType: "application/json" },
      });
      const result = await model.generateContent(prompt);
      return JSON.parse(result.response.text());
    };
  }

  // For studyWebsite and processSite, we still need genAI (or a wrapper)
  if (!genAI && geminiKey) {
    genAI = new GoogleGenerativeAI(geminiKey);
  }
  if (!genAI && openaiKey) {
    // Create a minimal genAI-compatible wrapper so existing functions work with OpenAI
    genAI = createOpenAICompatWrapper(openaiKey) as any;
  }

  const serpApiKey = process.env.SERPAPI_KEY;
  if (!serpApiKey) {
    console.log("Note: SERPAPI_KEY not set — skipping SERP research (content will be generated without competitor analysis).\n");
  }

  // Try loading sites from dashboard first, fallback to local JSON
  let sites: Site[] = await fetchSitesFromDashboard();
  if (sites.length === 0) {
    if (!fs.existsSync(SITES_FILE)) {
      console.error("Error: No sites found in dashboard or .claude/cache/sites.json.");
      process.exit(1);
    }
    sites = JSON.parse(fs.readFileSync(SITES_FILE, "utf-8"));
  }
  if (!Array.isArray(sites) || sites.length === 0) {
    console.error("Error: No sites configured.");
    process.exit(1);
  }

  ensureDirectories(sites);
  ensureCacheFiles();

  const publishedPosts = loadPublishedPosts();
  const topicIdeas = loadTopicIdeas();

  console.log(`Sites: ${sites.length}`);
  console.log(`Previously published: ${publishedPosts.length} post(s)\n`);

  const newPosts: PublishedPost[] = [];
  const newIdeas: TopicIdea[] = [];
  let imageAppend = "";
  const summary: string[] = [];

  for (const site of sites) {
    console.log(`\n========== ${site.name} (${site.domain}) ==========`);

    // Step 1: Study the website
    console.log(`[1/${serpApiKey ? "4" : "3"}] Studying website...`);
    const profile = await studyWebsite(genAI!, site);

    // Step 2: SERP Research (if API key available)
    let serpData: SerpResearchResult | null = null;
    if (serpApiKey) {
      console.log(`[2/4] SERP Research — analyzing Google competitors...`);
      try {
        serpData = await performSerpResearch(aiRequestFn, site, serpApiKey);
        console.log(`  Found ${serpData.topResults.length} results, ${serpData.peopleAlsoAsk.length} PAA questions, ${serpData.topArticleSummaries.length} articles analyzed`);
      } catch (err: any) {
        console.log(`  SERP research failed (${err.message}), continuing without competitor data`);
      }
    }

    // Step 3: Generate content
    console.log(`[${serpApiKey ? "3/4" : "2/3"}] Generating blog post...`);
    const result = await processSite(genAI!, site, profile, publishedPosts, topicIdeas, serpData);

    if (result) {
      newPosts.push(result.post);
      newIdeas.push(result.topicIdea);
      imageAppend += result.imageEntry;

      const statusIcon = result.post.status === "published" ? "✓ PUBLISHED" :
                          result.post.status === "publish_failed" ? "✗ PUBLISH FAILED" : "◐ DRAFT";
      summary.push(`${statusIcon} | ${site.name}: "${result.post.topic}" → ${result.post.publishedUrl || result.post.outputPath}`);
    } else {
      summary.push(`✗ FAILED | ${site.name}: generation failed`);
    }
  }

  // Update cache files
  if (newPosts.length > 0) {
    const allPosts = [...publishedPosts, ...newPosts];
    fs.writeFileSync(PUBLISHED_FILE, JSON.stringify(allPosts, null, 2));

    const allIdeas = [...topicIdeas, ...newIdeas];
    fs.writeFileSync(TOPIC_IDEAS_FILE, JSON.stringify(allIdeas, null, 2));

    if (imageAppend) {
      fs.appendFileSync(IMAGE_PROMPTS_FILE, imageAppend);
    }

    const today = new Date().toISOString().split("T")[0];
    const researchEntry = `\n## Run — ${today}\n${newPosts.map((p) => `- **${p.site}**: "${p.topic}" [${p.keywords.join(", ")}] — ${p.status}`).join("\n")}\n`;
    fs.appendFileSync(RESEARCH_FILE, researchEntry);
  }

  // Print summary
  console.log("\n\n╔══════════════════════════════════════════╗");
  console.log("║           RUN SUMMARY                    ║");
  console.log("╠══════════════════════════════════════════╣");
  for (const line of summary) {
    console.log(`║ ${line}`);
  }
  console.log("╠══════════════════════════════════════════╣");
  console.log(`║ Cache updated: published_posts, topic_ideas, image_prompts, research_notes`);
  console.log(`║ Total posts: ${publishedPosts.length + newPosts.length}`);
  console.log("╚══════════════════════════════════════════╝");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
