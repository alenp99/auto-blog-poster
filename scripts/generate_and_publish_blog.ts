#!/usr/bin/env npx ts-node

/**
 * generate_and_publish_blog.ts
 *
 * Main entry point for the auto blog publisher.
 * 1. Crawls each target website to study its style, content, and structure
 * 2. Uses Gemini AI to generate blog posts that match the site
 * 3. Publishes directly to the site's blog API
 *
 * Triggered by: n8n (every 4 days at 8 AM Sydney) → GitHub Actions → this script
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import * as http from "http";

const ROOT = path.resolve(__dirname, "..");
const CACHE_DIR = path.join(ROOT, ".claude", "cache");
const OUTPUT_DIR = path.join(ROOT, "output");
const SITE_PROFILES_DIR = path.join(CACHE_DIR, "site_profiles");
const SITES_FILE = path.join(CACHE_DIR, "sites.json");
const PUBLISHED_FILE = path.join(CACHE_DIR, "published_posts.json");
const TOPIC_IDEAS_FILE = path.join(CACHE_DIR, "topic_ideas.json");
const RESEARCH_FILE = path.join(CACHE_DIR, "research_notes.md");
const IMAGE_PROMPTS_FILE = path.join(CACHE_DIR, "image_prompts.md");

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
  const dirs = [CACHE_DIR, SITE_PROFILES_DIR, path.join(OUTPUT_DIR, "api_payloads")];
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
  topicIdeas: TopicIdea[]
): string {
  const sitePosts = publishedPosts.filter((p) => p.site === site.name);
  const publishedTopics = sitePosts.map((p) => p.topic);
  const previousIdeas = topicIdeas
    .filter((t) => t.site === site.name)
    .flatMap((t) => [t.selected, ...t.rejected]);

  const today = new Date().toISOString().split("T")[0];

  return `You are an expert SEO blog writer. You have studied the website below and must write a blog post that perfectly matches its style, voice, and audience.

WEBSITE ANALYSIS:
- Domain: ${site.domain}
- Description: ${profile.siteDescription}
- Brand Voice: ${profile.brandVoice}
- Content Style: ${profile.contentStyle}
- Heading Structure: ${profile.headingStructure}
- CTA Style: ${profile.ctaStyle}
- Topics Covered: ${profile.topics.join(", ")}

EXISTING BLOG POSTS ON THE SITE:
${profile.blogPosts.length > 0 ? profile.blogPosts.map((url) => `- ${url}`).join("\n") : "- No existing posts found"}

SITE CONFIGURATION:
- Name: ${site.name}
- Niche: ${site.niche}
- Tone: ${site.tone}
- Target Keywords: ${site.target_keywords.join(", ")}
- Target Length: ${site.post_length} words
- Date: ${today}

PREVIOUSLY PUBLISHED TOPICS (DO NOT REPEAT OR USE VERY SIMILAR TOPICS):
${publishedTopics.length > 0 ? publishedTopics.map((t) => `- ${t}`).join("\n") : "- None yet (first post)"}

PREVIOUSLY CONSIDERED TOPICS:
${previousIdeas.length > 0 ? previousIdeas.map((t) => `- ${t}`).join("\n") : "- None yet"}

INSTRUCTIONS:
1. Based on the website analysis, propose 3 topic ideas that fit naturally alongside the existing content. Topics must NOT duplicate previously published or considered topics.
2. Select the BEST one based on SEO potential, novelty, and fit with the site's existing content.
3. Write the blog post matching the site's exact writing style, brand voice, and content structure.

RESPOND IN EXACTLY THIS JSON FORMAT (no markdown wrapping, pure JSON):
{
  "topicIdeas": {
    "selected": "The chosen topic title",
    "rejected": ["Alternative topic 1", "Alternative topic 2"],
    "reason": "Why this topic was selected over the others"
  },
  "post": {
    "title": "SEO-optimized title (under 60 chars)",
    "slug": "lowercase-hyphenated-slug",
    "metaTitle": "Meta title for search engines",
    "metaDescription": "150-160 character meta description with primary keyword",
    "excerpt": "2-3 sentence summary for cards/previews",
    "category": "Primary category",
    "tags": ["tag1", "tag2", "tag3", "tag4"],
    "outline": ["H2: Section 1", "H3: Subsection", "H2: Section 2"],
    "content": "The full article in markdown format, ${site.post_length} words, matching the site's writing style, with proper heading hierarchy, FAQ section (3-5 questions), and CTA section at the end",
    "imagePrompt": "Detailed prompt for AI image generation - describe style, composition, colors, mood that match the site's visual identity",
    "socialSnippets": {
      "linkedin": "LinkedIn post snippet (under 300 chars)",
      "twitter": "Twitter/X post snippet (under 280 chars)"
    }
  }
}

CRITICAL QUALITY REQUIREMENTS:
- Match the site's brand voice and writing style EXACTLY as described in the analysis
- Use the same heading structure pattern found on the site
- Match the content style (paragraph length, list usage, technical depth)
- Use the same CTA approach the site already uses
- Article must be original, practical, and business-ready
- Bold key terms on first use
- Include a FAQ section with 3-5 questions and concise answers
- End with a CTA that matches the site's existing CTA style
- The content field must contain the FULL article, not a summary`;
}

// ---------------------------------------------------------------------------
// Generate content and publish for a single site
// ---------------------------------------------------------------------------
async function processSite(
  genAI: GoogleGenerativeAI,
  site: Site,
  profile: SiteProfile,
  publishedPosts: PublishedPost[],
  topicIdeas: TopicIdea[]
): Promise<{
  post: PublishedPost;
  topicIdea: TopicIdea;
  imageEntry: string;
} | null> {
  const today = new Date().toISOString().split("T")[0];

  const prompt = buildPromptForSite(site, profile, publishedPosts, topicIdeas);

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

  // Build API payload
  const apiPayload = {
    title: post.title,
    slug: post.slug,
    metaTitle: post.metaTitle,
    metaDescription: post.metaDescription,
    excerpt: post.excerpt,
    content: post.content,
    category: post.category,
    tags: post.tags,
    date: today,
    imagePrompt: post.imagePrompt,
    socialSnippets: post.socialSnippets,
    status: site.auto_publish ? "published" : "draft",
  };

  // Save payload locally regardless of publish method
  const payloadFileName = `${site.name.toLowerCase()}_${post.slug}.json`;
  const payloadPath = path.join(ROOT, "output", "api_payloads", payloadFileName);
  fs.writeFileSync(payloadPath, JSON.stringify(apiPayload, null, 2));
  console.log(`  Payload saved: output/api_payloads/${payloadFileName}`);

  let outputPath = `output/api_payloads/${payloadFileName}`;
  let publishedUrl = "";
  let status = "draft";

  // Also generate MDX if configured
  if (site.content_mode === "mdx" && site.content_path) {
    const mdxContent = `---
title: "${post.title}"
slug: "${post.slug}"
metaTitle: "${post.metaTitle}"
metaDescription: "${post.metaDescription}"
excerpt: "${post.excerpt}"
date: "${today}"
category: "${post.category}"
tags: ${JSON.stringify(post.tags)}
featuredImage: "/images/blog/${post.slug}.webp"
imagePrompt: "${post.imagePrompt.replace(/"/g, '\\"')}"
author: "${site.name} Team"
draft: ${!site.auto_publish}
---

${post.content}
`;
    const mdxPath = path.join(ROOT, site.content_path, `${post.slug}.mdx`);
    fs.writeFileSync(mdxPath, mdxContent);
    outputPath = `${site.content_path}/${post.slug}.mdx`;
    console.log(`  MDX file: ${outputPath}`);
  }

  // Publish to API if endpoint is configured and auto_publish is on
  if (site.publish_endpoint && site.auto_publish) {
    console.log(`  Publishing to ${site.publish_endpoint}...`);
    const publishResult = await publishToApi(site, apiPayload);

    if (publishResult.success) {
      status = "published";
      publishedUrl = publishResult.url || `${site.domain}/blog/${post.slug}`;
      console.log(`  Published successfully: ${publishedUrl}`);
    } else {
      status = "publish_failed";
      console.error(`  Publish failed: ${publishResult.error}`);
      console.log(`  Payload saved locally for manual retry`);
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
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log("=== Auto Blog Publisher (Gemini AI) ===");
  console.log(`Run started: ${new Date().toISOString()}\n`);

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("Error: GEMINI_API_KEY environment variable not set.");
    process.exit(1);
  }

  if (!fs.existsSync(SITES_FILE)) {
    console.error("Error: .claude/cache/sites.json not found.");
    process.exit(1);
  }

  const sites: Site[] = JSON.parse(fs.readFileSync(SITES_FILE, "utf-8"));
  if (!Array.isArray(sites) || sites.length === 0) {
    console.error("Error: No sites configured.");
    process.exit(1);
  }

  ensureDirectories(sites);
  ensureCacheFiles();

  const publishedPosts = loadPublishedPosts();
  const topicIdeas = loadTopicIdeas();
  const genAI = new GoogleGenerativeAI(apiKey);

  console.log(`Sites: ${sites.length}`);
  console.log(`Previously published: ${publishedPosts.length} post(s)\n`);

  const newPosts: PublishedPost[] = [];
  const newIdeas: TopicIdea[] = [];
  let imageAppend = "";
  const summary: string[] = [];

  for (const site of sites) {
    console.log(`\n========== ${site.name} (${site.domain}) ==========`);

    // Step 1: Study the website
    console.log(`[1/3] Studying website...`);
    const profile = await studyWebsite(genAI, site);

    // Step 2: Generate content
    console.log(`[2/3] Generating blog post...`);
    const result = await processSite(genAI, site, profile, publishedPosts, topicIdeas);

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
