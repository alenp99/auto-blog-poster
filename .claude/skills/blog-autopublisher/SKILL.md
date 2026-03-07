---
name: auto-blog-publisher
description: Study target websites, generate matching blog posts with Gemini AI, and publish directly to their blog APIs. Triggered by n8n every 4 days at 8 AM Sydney time.
---

When invoked, follow this workflow:

## Step 1 — Load Cache

Read all cache files before doing anything:
- `.claude/cache/sites.json` — site configs with API endpoints
- `.claude/cache/published_posts.json` — previously published posts
- `.claude/cache/topic_ideas.json` — candidate and rejected topics
- `.claude/cache/research_notes.md` — cached research and sources
- `.claude/cache/image_prompts.md` — previously used image prompts
- `.claude/cache/site_profiles/` — cached website analysis profiles

## Step 2 — Study Each Website

For each site in sites.json:
- Crawl the homepage to understand the company, product, and brand
- Crawl the blog listing page to find existing posts
- Fetch 2-3 existing blog posts and analyze:
  - Writing style (paragraph length, tone, technical depth)
  - Heading structure (H2/H3 patterns)
  - CTA approach (placement, tone, what they promote)
  - Topics and categories already covered
  - Brand voice and personality
- Cache the site profile for 7 days to avoid re-crawling
- Use this analysis to ensure generated content matches the site exactly

## Step 3 — Topic Selection

- Based on the site analysis, propose 3 topic ideas that fit naturally with existing content
- Each must be distinct from all previously published topics
- Select the best one based on: SEO value, novelty, audience fit, keyword opportunity
- Save all 3 candidates (chosen + rejected) to `topic_ideas.json`

## Step 4 — Content Generation

Generate content that matches the studied website's style:
- **SEO title** — compelling, keyword-rich, under 60 characters
- **slug** — lowercase, hyphenated, concise
- **meta title** — optimized for search
- **meta description** — 150–160 characters, includes primary keyword
- **excerpt** — 2–3 sentence summary
- **category** — one primary category matching existing site categories
- **tags** — 3–6 relevant tags
- **article outline** — H2/H3 structure matching the site's pattern
- **full article** — 1200–1800 words, matching site's writing style exactly
- **FAQ section** — 3–5 questions with concise answers
- **CTA section** — matching the site's existing CTA approach
- **social snippets** — one for LinkedIn, one for Twitter/X
- **featured image prompt** — matching the site's visual identity

## Step 5 — Publish to API

For each site with a `publish_endpoint`:
1. Build the JSON payload with all post fields
2. Save the payload locally to `output/api_payloads/` as backup
3. POST the payload to the site's blog API endpoint
4. Include the `publish_api_key` as Bearer token in Authorization header
5. Log success or failure
6. If publish fails, the local payload is preserved for manual retry

For MDX sites, also generate the `.mdx` file with frontmatter in the `content_path`.

## Step 6 — Update Cache

After each site is processed:
- Append post details to `published_posts.json` (including publishedUrl and status)
- Append image prompt to `image_prompts.md`
- Update `topic_ideas.json` with all candidates
- Update `research_notes.md` with run summary

## Step 7 — Run Summary

Output a summary showing:
- Each site processed
- Topic selected and why
- Publish status (PUBLISHED / DRAFT / FAILED)
- Published URL or local file path
- Cache files updated
