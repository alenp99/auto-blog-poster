#!/usr/bin/env npx ts-node

/**
 * generate_and_publish_blog.ts
 *
 * Main entry point for the auto blog publisher.
 * Uses Google Gemini AI to generate SEO blog posts for configured sites.
 * Triggered by: n8n (every 4 days) → GitHub Actions → this script
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "..");
const CACHE_DIR = path.join(ROOT, ".claude", "cache");
const OUTPUT_DIR = path.join(ROOT, "output");
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
  status: string;
}

interface TopicIdea {
  site: string;
  date: string;
  selected: string;
  rejected: string[];
  reason: string;
}

function ensureDirectories(sites: Site[]) {
  const dirs = [CACHE_DIR, path.join(OUTPUT_DIR, "api_payloads")];
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

function buildPromptForSite(
  site: Site,
  publishedPosts: PublishedPost[],
  topicIdeas: TopicIdea[]
): string {
  const sitePosts = publishedPosts.filter((p) => p.site === site.name);
  const publishedTopics = sitePosts.map((p) => p.topic);
  const previousIdeas = topicIdeas
    .filter((t) => t.site === site.name)
    .flatMap((t) => [t.selected, ...t.rejected]);

  const today = new Date().toISOString().split("T")[0];

  return `You are an expert SEO blog writer. Generate a complete blog post for the following site.

SITE CONFIGURATION:
- Name: ${site.name}
- Domain: ${site.domain}
- Niche: ${site.niche}
- Tone: ${site.tone}
- Target Keywords: ${site.target_keywords.join(", ")}
- Target Length: ${site.post_length} words
- Content Mode: ${site.content_mode}
- Date: ${today}

PREVIOUSLY PUBLISHED TOPICS (DO NOT REPEAT OR USE VERY SIMILAR TOPICS):
${publishedTopics.length > 0 ? publishedTopics.map((t) => `- ${t}`).join("\n") : "- None yet (first post)"}

PREVIOUSLY CONSIDERED TOPICS:
${previousIdeas.length > 0 ? previousIdeas.map((t) => `- ${t}`).join("\n") : "- None yet"}

INSTRUCTIONS:
1. First, propose exactly 3 unique topic ideas that are NOT duplicates or very similar to the previously published or considered topics. For each, explain why it's a good fit.
2. Select the BEST one based on SEO potential, novelty, and audience fit.
3. Then generate the COMPLETE blog post with ALL of the following fields.

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
    "content": "The full article in markdown format, 1200-1800 words, with proper H2/H3 hierarchy, FAQ section (3-5 questions), and CTA section at the end",
    "imagePrompt": "Detailed prompt for AI image generation - describe style, composition, colors, mood",
    "socialSnippets": {
      "linkedin": "LinkedIn post snippet (under 300 chars)",
      "twitter": "Twitter/X post snippet (under 280 chars)"
    }
  }
}

QUALITY REQUIREMENTS:
- Article must be original, practical, and business-ready
- Use proper heading hierarchy (## for H2, ### for H3)
- Write short paragraphs (2-4 sentences)
- Include bullet points and numbered lists where appropriate
- Bold key terms on first use
- Maintain "${site.tone}" tone throughout
- Include a FAQ section with 3-5 questions and concise answers
- End with a compelling CTA section
- The content field must contain the FULL article, not a summary`;
}

function generateMdxFile(site: Site, post: any, today: string): string {
  return `---
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
}

function generateApiPayload(site: Site, post: any, today: string): object {
  return {
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
}

async function processSite(
  genAI: GoogleGenerativeAI,
  site: Site,
  publishedPosts: PublishedPost[],
  topicIdeas: TopicIdea[]
): Promise<{
  post: PublishedPost;
  topicIdea: TopicIdea;
  imageEntry: string;
  outputPath: string;
} | null> {
  const today = new Date().toISOString().split("T")[0];

  console.log(`\n--- Processing: ${site.name} ---`);
  console.log(`Niche: ${site.niche}`);
  console.log(`Mode: ${site.content_mode}`);

  const prompt = buildPromptForSite(site, publishedPosts, topicIdeas);

  const model = genAI.getGenerativeModel({
    model: "gemini-2.0-flash",
    generationConfig: {
      temperature: 0.8,
      maxOutputTokens: 8192,
      responseMimeType: "application/json",
    },
  });

  console.log("Generating content with Gemini...");

  let result;
  try {
    result = await model.generateContent(prompt);
  } catch (err: any) {
    console.error(`Gemini API error for ${site.name}:`, err.message);
    return null;
  }

  const responseText = result.response.text();
  let parsed: any;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    // Try extracting JSON from markdown code blocks
    const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      parsed = JSON.parse(jsonMatch[1].trim());
    } else {
      console.error(`Failed to parse Gemini response for ${site.name}`);
      console.error("Raw response:", responseText.substring(0, 500));
      return null;
    }
  }

  const post = parsed.post;
  const ideas = parsed.topicIdeas;

  console.log(`Topic selected: "${ideas.selected}"`);
  console.log(`Reason: ${ideas.reason}`);

  // Generate output file
  let outputPath: string;

  if (site.content_mode === "mdx") {
    const mdxContent = generateMdxFile(site, post, today);
    const mdxPath = path.join(ROOT, site.content_path!, `${post.slug}.mdx`);
    fs.writeFileSync(mdxPath, mdxContent);
    outputPath = `${site.content_path}/${post.slug}.mdx`;
    console.log(`MDX file created: ${outputPath}`);
  } else {
    const payload = generateApiPayload(site, post, today);
    const payloadFileName = `${site.name.toLowerCase()}_${post.slug}.json`;
    const payloadPath = path.join(
      ROOT,
      "output",
      "api_payloads",
      payloadFileName
    );
    fs.writeFileSync(payloadPath, JSON.stringify(payload, null, 2));
    outputPath = `output/api_payloads/${payloadFileName}`;
    console.log(`API payload created: ${outputPath}`);
  }

  // Build return data
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
    status: site.auto_publish ? "published" : "draft",
  };

  const topicIdea: TopicIdea = {
    site: site.name,
    date: today,
    selected: ideas.selected,
    rejected: ideas.rejected,
    reason: ideas.reason,
  };

  const imageEntry = `\n## ${site.name} — ${today}\n**Topic:** ${post.title}\n**Prompt:** ${post.imagePrompt}\n`;

  return { post: publishedPost, topicIdea, imageEntry, outputPath };
}

async function main() {
  console.log("=== Auto Blog Publisher (Gemini AI) ===");
  console.log(`Run started: ${new Date().toISOString()}`);

  // Validate API key
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("Error: GEMINI_API_KEY environment variable not set.");
    process.exit(1);
  }

  // Validate sites
  if (!fs.existsSync(SITES_FILE)) {
    console.error("Error: .claude/cache/sites.json not found.");
    process.exit(1);
  }

  const sites: Site[] = JSON.parse(fs.readFileSync(SITES_FILE, "utf-8"));
  if (!Array.isArray(sites) || sites.length === 0) {
    console.error("Error: No sites configured.");
    process.exit(1);
  }

  // Setup
  ensureDirectories(sites);
  ensureCacheFiles();

  const publishedPosts = loadPublishedPosts();
  const topicIdeas = loadTopicIdeas();
  const genAI = new GoogleGenerativeAI(apiKey);

  console.log(`\nSites: ${sites.length}`);
  console.log(`Previously published: ${publishedPosts.length} post(s)`);

  // Process each site
  const newPosts: PublishedPost[] = [];
  const newIdeas: TopicIdea[] = [];
  let imageAppend = "";
  const summary: string[] = [];

  for (const site of sites) {
    const result = await processSite(genAI, site, publishedPosts, topicIdeas);

    if (result) {
      newPosts.push(result.post);
      newIdeas.push(result.topicIdea);
      imageAppend += result.imageEntry;
      summary.push(
        `✓ ${site.name}: "${result.post.topic}" → ${result.outputPath}`
      );
    } else {
      summary.push(`✗ ${site.name}: generation failed`);
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

    // Update research notes
    const today = new Date().toISOString().split("T")[0];
    const researchEntry = `\n## Run — ${today}\n${newPosts.map((p) => `- **${p.site}**: "${p.topic}" [${p.keywords.join(", ")}]`).join("\n")}\n`;
    fs.appendFileSync(RESEARCH_FILE, researchEntry);
  }

  // Print summary
  console.log("\n=== Run Summary ===");
  for (const line of summary) {
    console.log(line);
  }
  console.log(`\nCache files updated: published_posts.json, topic_ideas.json, image_prompts.md, research_notes.md`);
  console.log(`Total posts now: ${publishedPosts.length + newPosts.length}`);
  console.log("=== Done ===");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
