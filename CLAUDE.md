# Auto Blog Updater

You are managing an automated blog publishing system for custom Next.js websites.
The system is triggered externally by n8n every 4 days at 8 AM Sydney time.

## How It Works

1. **Study** — Crawl each target website (homepage + existing blog posts) to understand its style, voice, and content
2. **SERP Research** — Query Google via SerpAPI to analyze top-ranking competitors, extract People Also Ask questions, identify content gaps, and understand what Google rewards for the site's niche keywords
3. **Generate** — Use Gemini AI to create blog posts informed by both the site's style and SERP competitor intelligence
4. **Publish** — POST the generated content directly to each site's blog API

## Rules

1. Before generating anything, read all cache files:
   - `.claude/cache/sites.json` — target sites with API endpoints
   - `.claude/cache/published_posts.json` — previously published posts
   - `.claude/cache/topic_ideas.json` — candidate topics and rejected ideas
   - `.claude/cache/research_notes.md` — cached research, sources, keywords
   - `.claude/cache/image_prompts.md` — previously used image prompts
   - `.claude/cache/site_profiles/` — cached website analysis (refreshed weekly)
   - `.claude/cache/serp_results/` — cached SerpAPI responses (refreshed every 4 days)

2. Always study the target website before generating content.
3. Generated content must match the site's actual writing style, brand voice, and structure.
4. Do not regenerate topics already published or very similar to published topics.
5. Prefer reusing cached research and site profiles unless expired.
6. For each target site, generate one SEO-friendly blog post.
7. Publish directly to the site's blog API endpoint.
8. Save a local backup of every payload to `output/api_payloads/`.
9. If publish fails, keep the local payload for manual retry.
10. Never repeat a topic unless explicitly told to refresh or rewrite.

## Content Standards

- Articles must match the target site's style exactly
- Maintain clean SEO-friendly structure with proper heading hierarchy
- Only fetch fresh information when the topic is time-sensitive
- Write from a business-ready perspective matching the site's brand voice

## Publishing

- **API sites**: POST JSON payload to `publish_endpoint` with `publish_api_key` as Bearer token
- **MDX sites**: Also generate `.mdx` file with frontmatter in `content_path`
- All payloads saved locally to `output/api_payloads/` as backup
- `publish_api_key` in sites.json references an environment variable name

## Environment Variables

- `GEMINI_API_KEY` — Required. Google Gemini API key for content generation
- `SERPAPI_KEY` — Optional. SerpAPI key for Google competitor research. If not set, SERP research is skipped and content is generated without competitor analysis
- `SYNTHERA_BLOG_API_KEY` / `TECHFUTURE_BLOG_API_KEY` — Bearer tokens for each site's blog API
- `DASHBOARD_URL` — Optional. Dashboard server URL (defaults to http://localhost:3000)
