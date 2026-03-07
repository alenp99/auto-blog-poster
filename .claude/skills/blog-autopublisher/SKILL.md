---
name: auto-blog-publisher
description: Generate, illustrate, and prepare blog posts for custom Next.js sites while avoiding duplicate topics and reusing cache. Triggered externally by n8n every 4 days.
---

When invoked, follow this workflow:

## Step 1 — Load Cache

Read all cache files before doing anything:
- `.claude/cache/sites.json` — site configs
- `.claude/cache/published_posts.json` — previously published posts
- `.claude/cache/topic_ideas.json` — candidate and rejected topics
- `.claude/cache/research_notes.md` — cached research and sources
- `.claude/cache/image_prompts.md` — previously used image prompts

## Step 2 — Analyze Each Site

For each site in sites.json:
- Identify the niche, audience, tone, and target keywords
- Review the site's previously published topics
- Understand the content mode (MDX file or API payload)

## Step 3 — Topic Selection

- Propose 3 strong topic options per site
- Each must be distinct from all previously published topics
- Select the best one based on: SEO value, novelty, audience fit, keyword opportunity
- Save all 3 candidates (chosen + rejected) to `topic_ideas.json`

## Step 4 — Content Generation

Generate the following for the selected topic:
- **SEO title** — compelling, keyword-rich, under 60 characters
- **slug** — lowercase, hyphenated, concise
- **meta title** — optimized for search, can differ slightly from SEO title
- **meta description** — 150–160 characters, includes primary keyword
- **excerpt** — 2–3 sentence summary for cards/previews
- **category** — one primary category
- **tags** — 3–6 relevant tags
- **article outline** — H2/H3 structure before writing
- **full article** — 1200–1800 words, original, practical, business-ready
- **FAQ section** — 3–5 questions with concise answers
- **CTA section** — contextual call-to-action aligned with the site's goals
- **social snippets** — one for LinkedIn, one for Twitter/X
- **featured image prompt** — detailed prompt for AI image generation

### Article Quality Standards
- Use proper heading hierarchy (H2 → H3, never skip levels)
- Write short paragraphs (2–4 sentences)
- Include bullet points and numbered lists where appropriate
- Bold key terms on first use
- Maintain the site's specified tone throughout
- Include transition sentences between sections
- End with a strong closing paragraph before the CTA

## Step 5 — Research (If Needed)

If the topic requires current information:
- Fetch only the minimum necessary fresh data
- Cite sources in the draft notes
- Store a concise summary in `.claude/cache/research_notes.md`
- Otherwise, reuse cached research

## Step 6 — Output Generation

### For MDX sites (`content_mode: "mdx"`):
Generate a complete `.mdx` file with this frontmatter structure:
```
---
title: "SEO Title Here"
slug: "the-slug"
metaTitle: "Meta Title Here"
metaDescription: "Meta description here."
excerpt: "Short excerpt here."
date: "YYYY-MM-DD"
category: "Category"
tags: ["tag1", "tag2", "tag3"]
featuredImage: "/images/blog/the-slug.webp"
imagePrompt: "The image generation prompt"
author: "Site Author"
draft: false
---
```
Save the file to: `{content_path}/{slug}.mdx`

### For API sites (`content_mode: "api"`):
Generate a JSON payload file saved to: `output/api_payloads/{site_name}_{slug}.json`
```json
{
  "title": "",
  "slug": "",
  "metaTitle": "",
  "metaDescription": "",
  "excerpt": "",
  "content": "",
  "category": "",
  "tags": [],
  "date": "",
  "imagePrompt": "",
  "status": "draft|published"
}
```
Set status to "published" only if `auto_publish: true` in sites.json.

## Step 7 — Update Cache

Append to `.claude/cache/published_posts.json`:
```json
{
  "site": "Site Name",
  "topic": "The Topic Title",
  "slug": "the-slug",
  "date": "YYYY-MM-DD",
  "keywords": ["kw1", "kw2"],
  "category": "Category",
  "tags": ["tag1", "tag2"],
  "imagePrompt": "The prompt used",
  "outputPath": "path/to/file.mdx or output/api_payloads/file.json",
  "status": "draft|published"
}
```

Append to `.claude/cache/image_prompts.md`:
```
## Site Name — YYYY-MM-DD
**Topic:** The Topic Title
**Prompt:** The full image prompt
```

Update `.claude/cache/topic_ideas.json` with all candidates:
```json
{
  "site": "Site Name",
  "date": "YYYY-MM-DD",
  "selected": "Chosen Topic",
  "rejected": ["Topic B", "Topic C"],
  "reason": "Why this topic was selected"
}
```

## Step 8 — Run Summary

Output a concise summary:
- **Selected topic** and why it was chosen
- **Files created or updated** (with paths)
- **Image prompt** used
- **Publish path** (MDX file) or **API payload** (JSON file)
- **Cache files updated**
- **Topics skipped** due to duplication (if any)
