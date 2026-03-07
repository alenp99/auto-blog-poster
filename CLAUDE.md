# Auto Blog Updater

You are managing an automated blog publishing system for custom Next.js websites.
The system is triggered externally by n8n every 4 days.

## Rules

1. Before researching or generating anything, read all cache files:
   - `.claude/cache/sites.json` — target sites and their config
   - `.claude/cache/published_posts.json` — previously published posts
   - `.claude/cache/topic_ideas.json` — candidate topics and rejected ideas
   - `.claude/cache/research_notes.md` — cached research, sources, keywords
   - `.claude/cache/image_prompts.md` — previously used image prompts

2. Do not regenerate topics already published or very similar to published topics.
3. Prefer reusing cached research unless the user explicitly asks for fresh information.
4. For each target site, generate one SEO-friendly blog post that matches the site's niche, audience, and tone.
5. Generate:
   - SEO title, slug, meta title, meta description, excerpt
   - category and tags
   - article outline
   - full article (1200–1800 words)
   - FAQ section, CTA section
   - social media snippets
   - featured image prompt
6. Save sources, topic decisions, and keywords to `.claude/cache/research_notes.md`
7. Save published post details to `.claude/cache/published_posts.json`
8. Save image prompts to `.claude/cache/image_prompts.md`
9. Save candidate topics (used and rejected) to `.claude/cache/topic_ideas.json`

## Publishing

- **MDX sites** (`content_mode: "mdx"`): Generate a complete `.mdx` file with frontmatter and place it in the site's `content_path`.
- **API sites** (`content_mode: "api"`): Generate a structured JSON payload and save it to `output/api_payloads/`.
- Prefer draft mode unless `auto_publish: true` is set in sites.json.

## Content Standards

- Articles must be original, practical, readable, and business-ready.
- Maintain clean SEO-friendly structure with proper heading hierarchy.
- Only fetch fresh information when the topic is time-sensitive.
- Never repeat a topic unless explicitly told to refresh or rewrite.
- If information is time-sensitive, refresh only that section, not the whole article.
