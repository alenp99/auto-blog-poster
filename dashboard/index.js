const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const https = require("https");
const http = require("http");

const app = express();
// v2 - with /api/generate endpoint
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

// ---------------------------------------------------------------------------
// JSON file database
// ---------------------------------------------------------------------------
// Use /data (Railway persistent volume) if writable, otherwise local
let DATA_DIR = path.join(__dirname, "data");
try {
  if (fs.existsSync("/data")) {
    fs.accessSync("/data", fs.constants.W_OK);
    DATA_DIR = "/data";
  }
} catch {}
console.log("Data directory: " + DATA_DIR);
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Images directory for permanent storage of generated images
const IMAGES_DIR = path.join(DATA_DIR, "images");
if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });

const SITES_FILE = path.join(DATA_DIR, "sites.json");
const POSTS_FILE = path.join(DATA_DIR, "posts.json");

function readJson(file, fallback = []) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}
function writeJson(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
function getSites() { return readJson(SITES_FILE, []); }
function saveSites(sites) { writeJson(SITES_FILE, sites); }
function getPosts() { return readJson(POSTS_FILE, []); }
function savePosts(posts) { writeJson(POSTS_FILE, posts); }

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/stored-images", express.static(IMAGES_DIR));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function esc(s) { return (s || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    client.get(url, { headers: { "User-Agent": "AutoBlogBot/1.0" }, timeout: 10000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let loc = res.headers.location;
        if (loc.startsWith("/")) { const u = new URL(url); loc = u.origin + loc; }
        fetchUrl(loc).then(resolve).catch(reject);
        return;
      }
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => resolve(data));
    }).on("error", reject);
  });
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, l, t) => "\n" + "#".repeat(Number(l)) + " " + t.replace(/<[^>]+>/g, "").trim() + "\n")
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "- $1")
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, "$1\n\n")
    .replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "$2")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#\d+;/g, "")
    .replace(/\s+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function extractTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? match[1].replace(/<[^>]+>/g, "").trim().split(/[|\-–—]/)[0].trim() : "";
}

function extractMetaDescription(html) {
  const match = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([\s\S]*?)["'][^>]*>/i)
    || html.match(/<meta[^>]*content=["']([\s\S]*?)["'][^>]*name=["']description["'][^>]*>/i);
  return match ? match[1].trim() : "";
}

function geminiRequest(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 2048, responseMimeType: "application/json" }
    });
    const req = https.request({
      hostname: "generativelanguage.googleapis.com",
      path: "/v1beta/models/gemini-2.0-flash:generateContent?key=" + GEMINI_API_KEY,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
    }, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          const text = parsed.candidates[0].content.parts[0].text;
          resolve(JSON.parse(text));
        } catch (e) { reject(new Error("Gemini parse error: " + data.substring(0, 300))); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function openaiRequest(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      response_format: { type: "json_object" }
    });
    const req = https.request({
      hostname: "api.openai.com",
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + OPENAI_API_KEY,
        "Content-Length": Buffer.byteLength(body)
      }
    }, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error("OpenAI error: " + parsed.error.message));
          const text = parsed.choices[0].message.content;
          resolve(JSON.parse(text));
        } catch (e) { reject(new Error("OpenAI parse error: " + data.substring(0, 300))); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function aiRequest(prompt) {
  if (OPENAI_API_KEY) return openaiRequest(prompt);
  if (GEMINI_API_KEY) return geminiRequest(prompt);
  return Promise.reject(new Error("No AI API key configured"));
}

function publishToApi(endpoint, apiKey, payload, method) {
  return new Promise((resolve) => {
    const url = new URL(endpoint);
    const client = url.protocol === "https:" ? https : http;
    const body = JSON.stringify(payload);
    const headers = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) };
    if (apiKey) headers["Authorization"] = "Bearer " + apiKey;
    const req = client.request({ hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: method || "POST", headers }, (res) => {
      let data = ""; res.on("data", (c) => data += c);
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          let postUrl = ""; let postSlug = "";
          try { const p = JSON.parse(data); postUrl = p.url || ""; postSlug = p.slug || ""; } catch {}
          resolve({ success: true, url: postUrl, slug: postSlug, raw: data });
        } else { resolve({ success: false, error: "HTTP " + res.statusCode + " " + data }); }
      });
    });
    req.on("error", (err) => resolve({ success: false, error: err.message }));
    req.write(body); req.end();
  });
}

function markdownToHtml(md) {
  if (!md) return "";
  let html = md
    .replace(/&(?!amp;|lt;|gt;|quot;)/g, "&amp;")
    .replace(/^### (.*$)/gm, '<h3 style="font-size:1.2rem;font-weight:700;margin:2rem 0 0.75rem">$1</h3>')
    .replace(/^## (.*$)/gm, '<h2 style="font-size:1.5rem;font-weight:700;margin:2.5rem 0 1rem;padding-bottom:0.5rem;border-bottom:1px solid currentColor;opacity:0.9">$1</h2>')
    .replace(/^# (.*$)/gm, '<h1 style="font-size:2rem;font-weight:800;margin:1rem 0 1.5rem">$1</h1>')
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.*?)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Handle lists — no color styles, inherit from site
  html = html.replace(/(^- .*$(\n|$))+/gm, (block) => {
    const items = block.trim().split("\n").map(l => '<li style="margin-bottom:0.5rem">' + l.replace(/^- /, "") + "</li>").join("\n");
    return '<ul style="margin:1rem 0 1.5rem 1.25rem;line-height:1.8">\n' + items + "\n</ul>\n";
  });
  html = html.replace(/(^\d+\. .*$(\n|$))+/gm, (block) => {
    const items = block.trim().split("\n").map(l => '<li style="margin-bottom:0.5rem">' + l.replace(/^\d+\. /, "") + "</li>").join("\n");
    return '<ol style="margin:1rem 0 1.5rem 1.25rem;line-height:1.8">\n' + items + "\n</ol>\n";
  });

  // Wrap remaining plain text in <p> — only spacing, no colors
  html = html.split("\n\n").map(block => {
    block = block.trim();
    if (!block) return "";
    if (block.startsWith("<h") || block.startsWith("<ul") || block.startsWith("<ol") || block.startsWith("<p")) return block;
    return '<p style="margin-bottom:1.25rem;line-height:1.9;font-size:1.05rem">' + block.replace(/\n/g, "<br>") + "</p>";
  }).join("\n\n");

  return html;
}

function generateImageUrl(keywords) {
  // Use Unsplash source for a relevant free image
  const query = encodeURIComponent(keywords.slice(0, 3).join(","));
  return "https://source.unsplash.com/1200x630/?" + query;
}

function openaiImageGenerate(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: "dall-e-3",
      prompt: prompt,
      n: 1,
      size: "1792x1024",
      quality: "standard"
    });
    const req = https.request({
      hostname: "api.openai.com",
      path: "/v1/images/generations",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + OPENAI_API_KEY,
        "Content-Length": Buffer.byteLength(body)
      }
    }, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message));
          resolve(parsed.data[0].url);
        } catch (e) { reject(new Error("Image parse error")); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// Download an image from a URL and save it to the persistent images directory.
// Returns the filename so it can be served permanently via /stored-images/.
function downloadAndStoreImage(imageUrl, slug) {
  return new Promise((resolve, reject) => {
    // Use slug-based filename for SEO (e.g. ai-chatbots-guide.png)
    const filename = (slug || crypto.randomUUID()) + ".png";
    const filepath = path.join(IMAGES_DIR, filename);
    const client = imageUrl.startsWith("https") ? https : http;

    const doDownload = (url) => {
      const c = url.startsWith("https") ? https : http;
      c.get(url, { timeout: 30000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          doDownload(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          return reject(new Error("Image download failed: HTTP " + res.statusCode));
        }
        const file = fs.createWriteStream(filepath);
        res.pipe(file);
        file.on("finish", () => { file.close(); resolve(filename); });
        file.on("error", (e) => { fs.unlink(filepath, () => {}); reject(e); });
      }).on("error", reject);
    };
    doDownload(imageUrl);
  });
}

// Build permanent image URL from filename
// reqOrNull can be an Express request object to derive the host from headers
function getStoredImageUrl(filename, reqOrNull) {
  let baseUrl = "";
  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    baseUrl = "https://" + process.env.RAILWAY_PUBLIC_DOMAIN;
  } else if (process.env.RAILWAY_STATIC_URL) {
    baseUrl = "https://" + process.env.RAILWAY_STATIC_URL;
  } else if (reqOrNull && reqOrNull.headers && reqOrNull.headers.host) {
    const proto = reqOrNull.headers["x-forwarded-proto"] || "https";
    baseUrl = proto + "://" + reqOrNull.headers.host;
  } else {
    baseUrl = "https://blog-dashboard-production-d31d.up.railway.app";
  }
  return baseUrl + "/stored-images/" + filename;
}

// ---------------------------------------------------------------------------
// Analysis progress tracking (in-memory, keyed by site id)
// ---------------------------------------------------------------------------
const analysisProgress = {};

function updateProgress(siteId, step, detail) {
  if (!analysisProgress[siteId]) analysisProgress[siteId] = { steps: [], status: "analyzing" };
  analysisProgress[siteId].steps.push({ step, detail, time: new Date().toISOString() });
  analysisProgress[siteId].currentStep = step;
  console.log(`[${siteId}] ${step}: ${detail}`);
}

function completeProgress(siteId) {
  if (analysisProgress[siteId]) analysisProgress[siteId].status = "done";
}

// ---------------------------------------------------------------------------
// Crawl & analyze a website with AI
// ---------------------------------------------------------------------------
async function analyzeWebsite(domain, siteId) {
  console.log("Analyzing " + domain + "...");

  updateProgress(siteId, "Connecting", "Fetching homepage...");
  let homepageHtml = "";
  try { homepageHtml = await fetchUrl(domain); } catch (e) { console.error("Fetch failed:", e.message); }
  updateProgress(siteId, "Homepage", "Crawled homepage (" + Math.round(homepageHtml.length / 1024) + " KB)");

  const title = extractTitle(homepageHtml);
  const description = extractMetaDescription(homepageHtml);
  const homepageText = htmlToText(homepageHtml).substring(0, 5000);

  // Try to find blog
  updateProgress(siteId, "Blog Discovery", "Looking for blog section...");
  let blogHtml = "";
  let blogPath = "/blog";
  for (const tryPath of ["/blog", "/blogs", "/articles", "/news", "/resources"]) {
    try {
      blogHtml = await fetchUrl(domain.replace(/\/$/, "") + tryPath);
      if (blogHtml.length > 500) { blogPath = tryPath; break; }
    } catch {}
  }
  updateProgress(siteId, "Blog Found", "Found blog at " + blogPath);

  // Extract blog post links
  const linkRegex = /<a[^>]*href="([^"]*)"[^>]*>/gi;
  const blogLinks = [];
  let match;
  while ((match = linkRegex.exec(blogHtml)) !== null) {
    let href = match[1];
    if (href.startsWith("/")) href = domain.replace(/\/$/, "") + href;
    if (href.startsWith(domain) && href.includes(blogPath + "/") && href !== domain.replace(/\/$/, "") + blogPath) {
      blogLinks.push(href);
    }
  }
  const uniqueBlogLinks = [...new Set(blogLinks)].slice(0, 3);

  // Fetch sample blog posts
  updateProgress(siteId, "Reading Posts", "Fetching " + uniqueBlogLinks.length + " sample blog posts...");
  const blogSamples = [];
  for (const link of uniqueBlogLinks) {
    try { blogSamples.push(htmlToText(await fetchUrl(link)).substring(0, 2000)); } catch {}
  }
  if (blogSamples.length > 0) updateProgress(siteId, "Posts Read", "Read " + blogSamples.length + " blog posts");

  // Try to discover blog API endpoint
  updateProgress(siteId, "API Discovery", "Probing for blog API endpoints...");
  let detectedApiEndpoint = "";
  const apiPaths = [
    "/api/blog", "/api/blogs", "/api/posts", "/api/articles",
    "/api/blog/create", "/api/posts/create", "/api/v1/posts", "/api/v1/blog",
    "/wp-json/wp/v2/posts", "/ghost/api/v3/content/posts"
  ];
  for (const apiPath of apiPaths) {
    try {
      const apiUrl = domain.replace(/\/$/, "") + apiPath;
      const apiRes = await fetchUrl(apiUrl);
      // Check if it returns JSON (likely a valid API)
      if (apiRes.trim().startsWith("{") || apiRes.trim().startsWith("[")) {
        detectedApiEndpoint = apiUrl;
        updateProgress(siteId, "API Found", "Detected API at " + apiPath);
        break;
      }
    } catch {}
  }

  // Also check page source for API clues
  let detectedApiFromSource = "";
  const apiPatterns = [
    /["']\/api\/blog[^"']*["']/gi,
    /["']\/api\/posts[^"']*["']/gi,
    /["']\/api\/articles[^"']*["']/gi,
    /fetch\(["']([^"']*\/api\/[^"']*blog[^"']*)["']/gi,
    /fetch\(["']([^"']*\/api\/[^"']*post[^"']*)["']/gi,
  ];
  for (const pat of apiPatterns) {
    const m = homepageHtml.match(pat) || blogHtml.match(pat);
    if (m && m[0]) {
      const cleaned = m[0].replace(/["']/g, "").replace(/fetch\(/g, "");
      if (cleaned.startsWith("/")) detectedApiFromSource = domain.replace(/\/$/, "") + cleaned;
      else if (cleaned.startsWith("http")) detectedApiFromSource = cleaned;
      break;
    }
  }

  if (!detectedApiEndpoint && detectedApiFromSource) {
    detectedApiEndpoint = detectedApiFromSource;
    updateProgress(siteId, "API Found", "Found API reference in source code");
  }
  if (!detectedApiEndpoint) updateProgress(siteId, "API Discovery", "No public API found — can be added manually in settings");

  const fallback = {
    name: title || new URL(domain).hostname.replace("www.", "").split(".")[0],
    niche: description || "General",
    tone: "professional and modern",
    target_keywords: [],
    blog_path: blogPath,
    brand_voice: "Professional",
    content_style: "Standard blog format",
    publish_endpoint: detectedApiEndpoint,
  };

  if (!OPENAI_API_KEY && !GEMINI_API_KEY) {
    updateProgress(siteId, "Complete", "No AI key — used basic crawl data");
    completeProgress(siteId);
    return fallback;
  }

  // Ask AI to analyze
  updateProgress(siteId, "AI Analysis", "Sending data to AI for deep analysis...");
  try {
    const analysis = await aiRequest(`Analyze this website and tell me about it. Study the homepage content and any blog posts to understand the business. Also determine the tech stack and likely blog API endpoint.

WEBSITE: ${domain}
PAGE TITLE: ${title}
META DESCRIPTION: ${description}
${detectedApiEndpoint ? "DETECTED API ENDPOINT: " + detectedApiEndpoint : "NO API ENDPOINT DETECTED VIA PROBING"}

HOMEPAGE CONTENT:
${homepageText}

BLOG POSTS (${blogSamples.length} samples):
${blogSamples.map((s, i) => "--- Post " + (i + 1) + " ---\n" + s).join("\n\n")}

Respond in this exact JSON format:
{
  "name": "The company/brand name (short, e.g. 'Synthera')",
  "niche": "What the company does and its industry in one line",
  "tone": "The writing tone (e.g. 'professional and modern', 'casual and friendly')",
  "target_keywords": ["keyword1", "keyword2", "keyword3", "keyword4", "keyword5"],
  "brand_voice": "Describe the brand personality and voice in one sentence",
  "content_style": "How articles are structured - paragraph length, heading patterns, use of lists",
  "tech_stack": "Detected tech stack (e.g. Next.js, WordPress, Ghost, custom)",
  "publish_endpoint": "The most likely blog post creation API endpoint URL, or empty string if unknown. For WordPress use /wp-json/wp/v2/posts, for Ghost use their API, for Next.js guess /api/blog/create, etc."
}`);
    // Use probed endpoint if found, otherwise use AI suggestion
    const finalEndpoint = detectedApiEndpoint || analysis.publish_endpoint || "";
    updateProgress(siteId, "Complete", "AI analysis finished — " + (analysis.name || "site") + " identified" + (finalEndpoint ? " (API: " + finalEndpoint + ")" : ""));
    completeProgress(siteId);
    return { ...analysis, blog_path: blogPath, publish_endpoint: finalEndpoint };
  } catch (err) {
    console.error("AI analysis failed, using fallback:", err.message);
    updateProgress(siteId, "Complete", "AI unavailable — used basic crawl data");
    completeProgress(siteId);
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// HTML renderer
// ---------------------------------------------------------------------------
function render(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - Auto Blog Dashboard</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <nav><div class="nav-inner">
    <a href="/" class="logo">Auto Blog Publisher</a>
    <div class="nav-links">
      <a href="/">Dashboard</a>
      <a href="/sites">Sites</a>
      <a href="/sites/add">Add Site</a>
      <a href="/posts">All Posts</a>
    </div>
  </div></nav>
  <main>${body}</main>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Routes: Dashboard
// ---------------------------------------------------------------------------
app.get("/", (req, res) => {
  const sites = getSites();
  const posts = getPosts();
  const pendingPosts = posts.filter(p => p.status === "pending_review");
  const publishedCount = posts.filter(p => p.status === "published").length;
  const analyzingCount = sites.filter(s => s.status === "analyzing").length;

  const pendingHtml = pendingPosts.length > 0
    ? pendingPosts.map(p => {
        const site = sites.find(s => s.id === p.site_id);
        return '<div class="post-card pending_review">' +
          '<div class="post-header"><span class="badge badge-pending">Pending Review</span>' +
          '<span class="site-tag">' + esc(site ? site.name : "Unknown") + '</span></div>' +
          '<h3>' + esc(p.title) + '</h3>' +
          '<p class="excerpt">' + esc(p.excerpt) + '</p>' +
          '<div class="post-actions"><a href="/posts/' + p.id + '" class="btn btn-primary">Review</a></div></div>';
      }).join("")
    : '<p class="empty-state">No posts pending review</p>';

  res.send(render("Dashboard", `
    <div class="dashboard">
      <h1>Dashboard</h1>
      <div class="stats">
        <div class="stat-card"><div class="stat-number">${sites.filter(s => s.status === "ready").length}</div><div class="stat-label">Sites</div></div>
        ${analyzingCount > 0 ? '<div class="stat-card"><div class="stat-number">' + analyzingCount + '</div><div class="stat-label">Analyzing</div></div>' : ''}
        <div class="stat-card"><div class="stat-number">${pendingPosts.length}</div><div class="stat-label">Pending</div></div>
        <div class="stat-card"><div class="stat-number">${publishedCount}</div><div class="stat-label">Published</div></div>
      </div>
      <h2>Pending Review</h2>
      <div class="post-list">${pendingHtml}</div>
    </div>
  `));
});

// ---------------------------------------------------------------------------
// Routes: Sites
// ---------------------------------------------------------------------------
app.get("/sites", (req, res) => {
  const sites = getSites();
  const posts = getPosts();

  const siteCards = sites.length > 0
    ? sites.map(s => {
        const count = posts.filter(p => p.site_id === s.id).length;
        const isAnalyzing = s.status === "analyzing";
        return '<div class="site-card">' +
          '<div class="site-header"><h3>' + esc(s.name || "Scanning...") + '</h3>' +
          (isAnalyzing ? '<span class="badge badge-analyzing">Analyzing...</span>' :
           s.auto_approved ? '<span class="badge badge-auto">Auto-publish</span>' :
           '<span class="badge badge-review">Review first</span>') +
          '</div>' +
          '<p class="domain"><a href="' + esc(s.domain) + '" target="_blank">' + esc(s.domain) + '</a></p>' +
          (s.niche ? '<p class="niche">' + esc(s.niche) + '</p>' : '') +
          (s.brand_voice ? '<p class="niche" style="font-style:italic">' + esc(s.brand_voice) + '</p>' : '') +
          '<div class="site-meta">' +
          '<span>' + count + ' post(s)</span>' +
          (s.tone ? '<span>Tone: ' + esc(s.tone) + '</span>' : '') +
          (s.target_keywords && s.target_keywords.length ? '<span>Keywords: ' + esc(s.target_keywords.slice(0, 3).join(", ")) + '</span>' : '') +
          '</div>' +
          '<div class="site-actions">' +
          (isAnalyzing ? '' : '<form method="POST" action="/sites/' + s.id + '/generate" style="display:inline"><button type="submit" class="btn btn-primary">Generate Post</button></form>') +
          (isAnalyzing ? '' : '<a href="/sites/' + s.id + '" class="btn btn-secondary">Settings</a>') +
          '<form method="POST" action="/sites/' + s.id + '/delete" style="display:inline" onsubmit="return confirm(\'Delete this site?\')"><button type="submit" class="btn btn-danger">Delete</button></form>' +
          '</div></div>';
      }).join("")
    : '<p class="empty-state">No sites yet. <a href="/sites/add">Add a website</a> to get started.</p>';

  res.send(render("Sites", `
    <div class="sites-page">
      <div class="page-header"><h1>Sites</h1><a href="/sites/add" class="btn btn-primary">+ Add Site</a></div>
      <div class="site-list">${siteCards}</div>
    </div>
  `));
});

app.get("/sites/add", (req, res) => {
  res.send(render("Add Site", `
    <div class="form-page">
      <h1>Add Website</h1>
      <p class="form-description">Just paste the URL. We'll crawl the site and figure out everything else automatically.</p>
      <form method="POST" action="/sites" class="site-form">
        <div class="form-group">
          <label>Website URL</label>
          <input type="url" name="domain" required placeholder="https://www.example.com" autofocus>
        </div>
        <button type="submit" class="btn btn-primary btn-large">Analyze Website</button>
      </form>
    </div>
  `));
});

app.post("/sites", async (req, res) => {
  let domain = req.body.domain.trim().replace(/\/$/, "");
  if (!domain.startsWith("http")) domain = "https://" + domain;

  // Check for duplicates
  const sites = getSites();
  if (sites.find(s => s.domain === domain)) {
    return res.send(render("Already Added", `<div class="form-page"><h1>Already added</h1><p>${esc(domain)} is already in your sites. <a href="/sites">View sites</a></p></div>`));
  }

  // Save immediately with "analyzing" status so the user sees it
  const id = crypto.randomUUID();
  sites.push({
    id, domain,
    name: new URL(domain).hostname.replace("www.", "").split(".")[0],
    status: "analyzing",
    auto_approved: false,
    created_at: new Date().toISOString(),
  });
  saveSites(sites);

  // Redirect to progress page — analysis happens in background
  res.redirect("/sites/" + id + "/progress");

  // Crawl and analyze in background
  try {
    const analysis = await analyzeWebsite(domain, id);
    const updatedSites = getSites();
    const idx = updatedSites.findIndex(s => s.id === id);
    if (idx !== -1) {
      updatedSites[idx] = {
        ...updatedSites[idx],
        name: analysis.name || updatedSites[idx].name,
        niche: analysis.niche || "",
        tone: analysis.tone || "professional and modern",
        target_keywords: analysis.target_keywords || [],
        blog_path: analysis.blog_path || "/blog",
        brand_voice: analysis.brand_voice || "",
        content_style: analysis.content_style || "",
        tech_stack: analysis.tech_stack || "",
        post_length: 1500,
        publish_endpoint: analysis.publish_endpoint || "",
        publish_api_key: "",
        status: "ready",
      };
      saveSites(updatedSites);
      console.log("Analysis complete for " + domain);
    }
  } catch (err) {
    console.error("Analysis failed for " + domain + ":", err.message);
    const updatedSites = getSites();
    const idx = updatedSites.findIndex(s => s.id === id);
    if (idx !== -1) {
      updatedSites[idx].status = "ready";
      updatedSites[idx].niche = "Could not auto-detect — edit to configure";
      saveSites(updatedSites);
    }
  }
});

// Progress page — live updates while analyzing
app.get("/sites/:id/progress", (req, res) => {
  const site = getSites().find(s => s.id === req.params.id);
  if (!site) return res.status(404).send(render("Not Found", "<h1>Site not found</h1>"));

  // If already done, redirect to settings
  if (site.status === "ready") return res.redirect("/sites/" + site.id);

  res.send(render("Analyzing " + esc(site.domain), `
    <div class="form-page" style="text-align:center">
      <div class="progress-icon">
        <svg width="64" height="64" viewBox="0 0 64 64" style="animation:spin 2s linear infinite">
          <circle cx="32" cy="32" r="28" stroke="var(--border)" stroke-width="4" fill="none"/>
          <arc cx="32" cy="32" r="28" stroke="var(--primary)" stroke-width="4" fill="none"/>
          <path d="M32 4 A28 28 0 0 1 60 32" stroke="var(--primary)" stroke-width="4" fill="none" stroke-linecap="round"/>
        </svg>
      </div>
      <h1 style="margin-top:1.5rem">Analyzing Website</h1>
      <p class="domain" style="margin-bottom:2rem"><a href="${esc(site.domain)}" target="_blank">${esc(site.domain)}</a></p>
      <div id="steps" class="progress-steps"></div>
      <p id="status-text" class="form-description" style="margin-top:1.5rem">Starting analysis...</p>
    </div>
    <style>
      @keyframes spin { to { transform: rotate(360deg); } }
      .progress-steps { text-align: left; max-width: 400px; margin: 0 auto; }
      .step { padding: 0.6rem 1rem; margin: 0.4rem 0; border-radius: 8px; background: var(--surface); border: 1px solid var(--border); display: flex; align-items: center; gap: 0.75rem; font-size: 0.9rem; }
      .step .check { color: var(--success); font-weight: bold; }
      .step .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--primary); animation: pulse 1s infinite; }
      .step .detail { color: var(--text-muted); font-size: 0.8rem; margin-left: auto; }
    </style>
    <script>
      const siteId = "${req.params.id}";
      let lastCount = 0;
      async function poll() {
        try {
          const res = await fetch("/api/sites/" + siteId + "/progress");
          const data = await res.json();
          const el = document.getElementById("steps");
          const statusEl = document.getElementById("status-text");
          if (data.steps && data.steps.length > 0) {
            el.innerHTML = data.steps.map((s, i) => {
              const isLast = i === data.steps.length - 1 && data.status !== "done";
              return '<div class="step">' +
                (isLast ? '<span class="dot"></span>' : '<span class="check">&#10003;</span>') +
                '<span>' + s.step + '</span>' +
                '<span class="detail">' + s.detail + '</span></div>';
            }).join("");
            statusEl.textContent = data.steps[data.steps.length - 1].detail;
          }
          if (data.status === "done") {
            statusEl.innerHTML = 'Analysis complete! <a href="/sites/${req.params.id}">View results</a>';
            setTimeout(() => { window.location.href = "/sites/${req.params.id}"; }, 1500);
            return;
          }
        } catch {}
        setTimeout(poll, 1000);
      }
      poll();
    </script>
  `));
});

// Progress API
app.get("/api/sites/:id/progress", (req, res) => {
  const progress = analysisProgress[req.params.id];
  if (progress) return res.json(progress);
  // Check if site is already ready
  const site = getSites().find(s => s.id === req.params.id);
  if (site && site.status === "ready") return res.json({ steps: [{ step: "Complete", detail: "Analysis finished" }], status: "done" });
  res.json({ steps: [], status: "analyzing" });
});

app.get("/sites/:id", (req, res) => {
  const site = getSites().find(s => s.id === req.params.id);
  if (!site) return res.status(404).send(render("Not Found", "<h1>Site not found</h1>"));
  const kw = (site.target_keywords || []).join(", ");

  res.send(render("Settings: " + site.name, `
    <div class="form-page">
      <h1>${esc(site.name)}</h1>
      <p class="domain"><a href="${esc(site.domain)}" target="_blank">${esc(site.domain)}</a></p>

      <div class="detected-info">
        <h2>Auto-detected</h2>
        <div class="meta-grid">
          <div class="meta-item"><strong>Niche</strong><span>${esc(site.niche)}</span></div>
          <div class="meta-item"><strong>Tone</strong><span>${esc(site.tone)}</span></div>
          <div class="meta-item"><strong>Keywords</strong><span>${esc(kw)}</span></div>
          <div class="meta-item"><strong>Brand Voice</strong><span>${esc(site.brand_voice)}</span></div>
          <div class="meta-item"><strong>Content Style</strong><span>${esc(site.content_style)}</span></div>
          <div class="meta-item"><strong>Blog Path</strong><span>${esc(site.blog_path)}</span></div>
          <div class="meta-item"><strong>Tech Stack</strong><span>${esc(site.tech_stack || "Unknown")}</span></div>
          ${site.publish_endpoint ? '<div class="meta-item"><strong>Detected API</strong><span>' + esc(site.publish_endpoint) + '</span></div>' : ''}
        </div>
        <form method="POST" action="/sites/${site.id}/rescan" style="display:inline">
          <button type="submit" class="btn btn-secondary">Re-scan Website</button>
        </form>
      </div>

      <h2>Publishing Settings (Optional)</h2>
      <form method="POST" action="/sites/${site.id}/update" class="site-form">
        <div class="form-group">
          <label>Blog API Endpoint</label>
          <input type="url" name="publish_endpoint" value="${esc(site.publish_endpoint)}" placeholder="https://yoursite.com/api/blog/create">
          <small>Leave empty if you don't have a blog API — posts will be saved locally</small>
        </div>
        <div class="form-group">
          <label>Blog API Key</label>
          <input type="text" name="publish_api_key" value="${esc(site.publish_api_key)}" placeholder="Your API key">
        </div>
        <button type="submit" class="btn btn-primary btn-large">Save</button>
      </form>

      <h2 style="margin-top:2rem">Generate Blog Post</h2>
      <p class="form-description">Generate a new SEO blog post for this site using AI right now.</p>
      <form method="POST" action="/sites/${site.id}/generate">
        <button type="submit" class="btn btn-primary btn-large">Generate Post Now</button>
      </form>
    </div>
  `));
});

app.post("/sites/:id/update", (req, res) => {
  const sites = getSites();
  const idx = sites.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).send("Not found");
  sites[idx].publish_endpoint = req.body.publish_endpoint || "";
  sites[idx].publish_api_key = req.body.publish_api_key || "";
  saveSites(sites);
  res.redirect("/sites/" + req.params.id);
});

app.post("/sites/:id/rescan", async (req, res) => {
  const sites = getSites();
  const idx = sites.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).send("Not found");
  sites[idx].status = "analyzing";
  saveSites(sites);
  res.redirect("/sites/" + req.params.id + "/progress");

  try {
    const analysis = await analyzeWebsite(sites[idx].domain, req.params.id);
    const updated = getSites();
    const i = updated.findIndex(s => s.id === req.params.id);
    if (i !== -1) {
      updated[i] = { ...updated[i], ...analysis, status: "ready" };
      saveSites(updated);
    }
  } catch (err) {
    console.error("Rescan failed:", err.message);
    const updated = getSites();
    const i = updated.findIndex(s => s.id === req.params.id);
    if (i !== -1) { updated[i].status = "ready"; saveSites(updated); }
  }
});

// Generate a blog post for a site
app.post("/sites/:id/generate", async (req, res) => {
  const sites = getSites();
  const site = sites.find(s => s.id === req.params.id);
  if (!site) return res.status(404).send("Not found");

  const genId = "gen-" + req.params.id;
  analysisProgress[genId] = { steps: [], status: "analyzing" };

  res.send(render("Generating Post", `
    <div class="form-page" style="text-align:center">
      <div class="progress-icon">
        <svg width="64" height="64" viewBox="0 0 64 64" style="animation:spin 2s linear infinite">
          <circle cx="32" cy="32" r="28" stroke="var(--border)" stroke-width="4" fill="none"/>
          <path d="M32 4 A28 28 0 0 1 60 32" stroke="var(--primary)" stroke-width="4" fill="none" stroke-linecap="round"/>
        </svg>
      </div>
      <h1 style="margin-top:1.5rem">Generating Blog Post</h1>
      <p class="domain" style="margin-bottom:2rem">${esc(site.name)} &mdash; <a href="${esc(site.domain)}" target="_blank">${esc(site.domain)}</a></p>
      <div id="steps" class="progress-steps"></div>
      <p id="status-text" class="form-description" style="margin-top:1.5rem">Starting generation...</p>
    </div>
    <style>
      @keyframes spin { to { transform: rotate(360deg); } }
      .progress-steps { text-align: left; max-width: 500px; margin: 0 auto; }
      .step { padding: 0.6rem 1rem; margin: 0.4rem 0; border-radius: 8px; background: var(--surface); border: 1px solid var(--border); display: flex; align-items: center; gap: 0.75rem; font-size: 0.9rem; }
      .step .check { color: var(--success); font-weight: bold; }
      .step .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--primary); animation: pulse 1s infinite; }
      .step .detail { color: var(--text-muted); font-size: 0.8rem; margin-left: auto; }
    </style>
    <script>
      const genId = "${genId}";
      async function poll() {
        try {
          const res = await fetch("/api/sites/" + genId.replace("gen-","") + "/generate-progress");
          const data = await res.json();
          const el = document.getElementById("steps");
          const statusEl = document.getElementById("status-text");
          if (data.steps && data.steps.length > 0) {
            el.innerHTML = data.steps.map((s, i) => {
              const isLast = i === data.steps.length - 1 && data.status !== "done";
              return '<div class="step">' +
                (isLast ? '<span class="dot"></span>' : '<span class="check">&#10003;</span>') +
                '<span>' + s.step + '</span>' +
                '<span class="detail">' + s.detail + '</span></div>';
            }).join("");
            statusEl.textContent = data.steps[data.steps.length - 1].detail;
          }
          if (data.status === "done") {
            statusEl.innerHTML = 'Blog post generated! Redirecting...';
            setTimeout(() => { window.location.href = data.postUrl || "/posts"; }, 1500);
            return;
          }
        } catch {}
        setTimeout(poll, 1000);
      }
      poll();
    </script>
  `));

  // Generate in background
  try {
    updateProgress(genId, "Crawling", "Fetching latest content from " + site.domain + "...");

    // Crawl the site for fresh context
    let homepageText = "";
    try {
      const html = await fetchUrl(site.domain);
      homepageText = htmlToText(html).substring(0, 3000);
    } catch {}

    let blogSamples = [];
    const blogUrl = site.domain.replace(/\/$/, "") + (site.blog_path || "/blog");
    try {
      const blogHtml = await fetchUrl(blogUrl);
      const linkRegex = /<a[^>]*href="([^"]*)"[^>]*>/gi;
      const links = [];
      let m;
      while ((m = linkRegex.exec(blogHtml)) !== null) {
        let href = m[1];
        if (href.startsWith("/")) href = site.domain.replace(/\/$/, "") + href;
        if (href.startsWith(site.domain) && href.includes(site.blog_path + "/")) links.push(href);
      }
      const unique = [...new Set(links)].slice(0, 3);
      for (const link of unique) {
        try { blogSamples.push(htmlToText(await fetchUrl(link)).substring(0, 1500)); } catch {}
      }
    } catch {}
    updateProgress(genId, "Content Gathered", "Read homepage + " + blogSamples.length + " existing blog posts");

    // Get existing post titles to avoid duplicates
    const existingPosts = getPosts().filter(p => p.site_id === site.id).map(p => p.title);
    updateProgress(genId, "Topic Selection", "AI is picking a unique topic...");

    // Generate the blog post
    const post = await aiRequest(`You are an expert SEO blog writer. Generate a complete blog post for this website.

WEBSITE: ${site.domain}
COMPANY: ${site.name}
NICHE: ${site.niche}
TONE: ${site.tone}
BRAND VOICE: ${site.brand_voice}
CONTENT STYLE: ${site.content_style}
TARGET KEYWORDS: ${(site.target_keywords || []).join(", ")}

HOMEPAGE CONTENT (for context):
${homepageText}

EXISTING BLOG POSTS (for style reference, DO NOT repeat these topics):
${blogSamples.map((s, i) => "--- Post " + (i + 1) + " ---\n" + s).join("\n\n")}

ALREADY PUBLISHED TITLES (DO NOT repeat or write anything similar):
${existingPosts.join("\n")}

TOPIC DIVERSITY — CRITICAL:
You MUST pick a topic that is genuinely DIFFERENT from the titles above. Do NOT just rephrase the same ideas.
Think beyond the obvious. Consider these angles for variety:
- Industry trends or news relevant to the niche
- Common mistakes businesses make (and how to avoid them)
- Behind-the-scenes / how things actually work
- Cost comparisons, budgeting, or ROI discussions
- Case study style: a specific problem and how it was solved
- Beginner guides or "what you need to know before..."
- Myths vs reality in the industry
- Hiring, team building, or workflow tips related to the niche
- Comparisons (e.g. option A vs option B)
- Seasonal or timely topics

Pick ONE angle from above (or come up with your own unique angle) that has NOT been covered yet.

Write a ~800 word blog post on this fresh topic.

WRITING RULES — VERY IMPORTANT:
- Write for a normal person, NOT a technical audience. Use simple, everyday language.
- Keep sentences short (under 20 words). Keep paragraphs to 2-3 sentences max.
- NO jargon, buzzwords, or filler phrases like "In today's rapidly evolving landscape" or "leveraging cutting-edge solutions".
- Be direct and practical. Give real examples and actionable tips.
- Use ## headings to break content into scannable sections (5-6 sections).
- Use bullet points for lists — keep each bullet to one line.
- Start with a hook that states the problem or benefit clearly.
- End with a short, clear call to action (1-2 sentences).
- The tone should feel like a helpful friend explaining something, not a corporate whitepaper.
- DO NOT use the word "revolutionize", "transform", "leverage", "cutting-edge", "game-changer", or "unlock".
- DO NOT start the title with "How". Vary your title formats.

Respond in this exact JSON format:
{
  "title": "Blog post title (60 chars max, include primary keyword naturally)",
  "slug": "keyword-rich-url-slug (3-5 words, include main keyword)",
  "metaTitle": "SEO meta title (60 chars max, primary keyword near the start)",
  "metaDescription": "Compelling meta description (150-155 chars, include keyword, end with a reason to click)",
  "excerpt": "1-2 sentence plain-English summary that makes people want to read more",
  "category": "Main category",
  "tags": ["tag1", "tag2", "tag3", "tag4", "tag5"],
  "content": "Full blog post in markdown. ~800 words. Must include: primary keyword in first paragraph, ## headings with related keywords, internal context about the company, short paragraphs, bullet points. End with a clear CTA.",
  "imageAlt": "Descriptive alt text for the hero image (include primary keyword, describe what the image shows, under 125 chars)",
  "imagePrompt": "A professional, modern image relevant to this specific article topic. Be specific about the scene — include details about setting, objects, people, and mood. Do NOT include any text or words in the image. Style: clean, professional, high-quality photograph look.",
  "socialSnippets": {
    "linkedin": "LinkedIn post to promote this article (2-3 sentences)",
    "twitter": "Tweet to promote this article (under 280 chars)"
  },
  "faq": [
    {"question": "Natural question people would search for about this topic", "answer": "Clear, concise answer (2-3 sentences)"},
    {"question": "Another common question", "answer": "Answer"},
    {"question": "Third question", "answer": "Answer"}
  ]
}`);

    updateProgress(genId, "Post Generated", "\"" + (post.title || "Untitled") + "\"");

    // Generate hero image and store permanently
    let imageUrl = "";
    updateProgress(genId, "Generating Image", "Creating hero image with DALL-E...");
    try {
      const dalleUrl = await openaiImageGenerate(post.imagePrompt || post.title);
      updateProgress(genId, "Saving Image", "Downloading image for permanent storage...");
      const filename = await downloadAndStoreImage(dalleUrl, post.slug);
      imageUrl = getStoredImageUrl(filename);
      updateProgress(genId, "Image Ready", "Hero image generated and stored permanently");
    } catch (err) {
      console.error("Image generation failed:", err.message);
      // Fallback to Unsplash
      const keywords = (site.target_keywords || []).length > 0 ? site.target_keywords : [post.category || site.niche || "technology"];
      imageUrl = generateImageUrl(keywords);
      updateProgress(genId, "Image Ready", "Using stock image (DALL-E unavailable)");
    }

    // Convert markdown to HTML for publishing
    const htmlContent = markdownToHtml(post.content);

    // Save the post
    const postId = crypto.randomUUID();
    let status = "pending_review";
    let publishedUrl = "";

    // Only auto-publish if site is auto-approved AND has a working API endpoint
    if (site.auto_approved && site.publish_endpoint) {
      updateProgress(genId, "Publishing", "Sending to blog API at " + site.publish_endpoint + "...");
      const payload = {
        title: post.title, slug: post.slug, excerpt: post.excerpt,
        content: htmlContent, image_url: imageUrl,
        image_alt: post.imageAlt || post.title,
        meta_title: post.metaTitle || post.title,
        meta_description: post.metaDescription || post.excerpt,
        tags: post.tags || [],
        category: post.category || "",
        author_name: site.name + " Team"
      };
      try {
        const r = await publishToApi(site.publish_endpoint, site.publish_api_key, payload);
        if (r.success) {
          status = "published";
          publishedUrl = r.url || (site.domain.replace(/\/$/, "") + (site.blog_path || "/blog") + "/" + (r.slug || post.slug));
          updateProgress(genId, "Published", "Live at " + publishedUrl);
        } else {
          updateProgress(genId, "Publish Failed", r.error + " — saved for review instead");
        }
      } catch (e) {
        updateProgress(genId, "Publish Failed", e.message + " — saved for review instead");
      }
    } else if (!site.auto_approved) {
      updateProgress(genId, "Needs Review", "First post — waiting for your approval before publishing");
    } else {
      updateProgress(genId, "No API", "No publish endpoint configured — saved for review");
    }

    const posts = getPosts();
    posts.push({
      id: postId, site_id: site.id, title: post.title, slug: post.slug,
      meta_title: post.metaTitle, meta_description: post.metaDescription,
      excerpt: post.excerpt, category: post.category,
      tags: post.tags || [], content: post.content,
      html_content: htmlContent,
      image_url: imageUrl,
      image_alt: post.imageAlt || post.title,
      image_prompt: post.imagePrompt,
      social_linkedin: (post.socialSnippets || {}).linkedin || "",
      social_twitter: (post.socialSnippets || {}).twitter || "",
      faq: post.faq || [],
      status, published_url: publishedUrl,
      generated_at: new Date().toISOString(),
    });
    savePosts(posts);

    updateProgress(genId, "Complete", status === "published" ? "Published successfully!" : "Ready for review");
    analysisProgress[genId].status = "done";
    analysisProgress[genId].postUrl = "/posts/" + postId;

  } catch (err) {
    console.error("Generation failed:", err.message);
    updateProgress(genId, "Error", "Generation failed: " + err.message);
    analysisProgress[genId].status = "done";
    analysisProgress[genId].postUrl = "/posts";
  }
});

// Generation progress API
app.get("/api/sites/:id/generate-progress", (req, res) => {
  const genId = "gen-" + req.params.id;
  const progress = analysisProgress[genId];
  if (progress) return res.json(progress);
  res.json({ steps: [], status: "analyzing" });
});

app.post("/sites/:id/delete", (req, res) => {
  saveSites(getSites().filter(s => s.id !== req.params.id));
  savePosts(getPosts().filter(p => p.site_id !== req.params.id));
  res.redirect("/sites");
});

// ---------------------------------------------------------------------------
// Routes: Posts
// ---------------------------------------------------------------------------
app.get("/posts", (req, res) => {
  const filter = req.query.status || "all";
  const sites = getSites();
  let posts = getPosts();
  if (filter !== "all") posts = posts.filter(p => p.status === filter);
  posts.sort((a, b) => (b.generated_at || "").localeCompare(a.generated_at || ""));

  const postRows = posts.length > 0
    ? posts.map(p => {
        const site = sites.find(s => s.id === p.site_id);
        const bc = p.status === "published" ? "badge-published" : p.status === "pending_review" ? "badge-pending" : "badge-rejected";
        return '<div class="post-card ' + p.status + '">' +
          '<div class="post-header"><span class="badge ' + bc + '">' + (p.status || "").replace(/_/g, " ") + '</span>' +
          '<span class="site-tag">' + esc(site ? site.name : "Unknown") + '</span></div>' +
          '<h3>' + esc(p.title) + '</h3>' +
          '<p class="excerpt">' + esc(p.excerpt) + '</p>' +
          '<div class="post-meta"><span>' + esc(p.category) + '</span><span>' + (p.generated_at || "").split("T")[0] + '</span>' +
          (p.published_url ? '<a href="' + esc(p.published_url) + '" target="_blank">View live</a>' : "") +
          '</div><div class="post-actions"><a href="/posts/' + p.id + '" class="btn btn-secondary">View</a></div></div>';
      }).join("")
    : '<p class="empty-state">No posts yet</p>';

  const tabs = [["all","All"],["pending_review","Pending"],["published","Published"],["rejected","Rejected"]];
  const tabsHtml = tabs.map(([v,l]) => '<a href="/posts?status=' + v + '" class="tab ' + (filter === v ? "active" : "") + '">' + l + '</a>').join("");

  res.send(render("Posts", `
    <div class="posts-page">
      <div class="page-header"><h1>Posts</h1><div class="filter-tabs">${tabsHtml}</div></div>
      <div class="post-list">${postRows}</div>
    </div>
  `));
});

app.get("/posts/:id", (req, res) => {
  const post = getPosts().find(p => p.id === req.params.id);
  if (!post) return res.status(404).send(render("Not Found", "<h1>Post not found</h1>"));
  const site = getSites().find(s => s.id === post.site_id);
  const tags = (post.tags || []).join(", ");
  const isPending = post.status === "pending_review";
  const bc = post.status === "published" ? "badge-published" : post.status === "pending_review" ? "badge-pending" : post.status === "approved" ? "badge-published" : "badge-rejected";

  res.send(render(post.title, `
    <div class="post-detail">
      <div class="post-detail-header">
        <a href="/posts" class="back-link">Back to posts</a>
        <div class="post-detail-meta">
          <span class="badge ${bc}">${(post.status || "").replace(/_/g, " ")}</span>
          <span class="site-tag">${esc(site ? site.name : "Unknown")}</span>
        </div>
      </div>
      <h1>${esc(post.title)}</h1>
      <div class="meta-grid">
        <div class="meta-item"><strong>Slug</strong><span>${esc(post.slug)}</span></div>
        <div class="meta-item"><strong>Meta Title</strong><span>${esc(post.meta_title)}</span></div>
        <div class="meta-item"><strong>Meta Description</strong><span>${esc(post.meta_description)}</span></div>
        <div class="meta-item"><strong>Excerpt</strong><span>${esc(post.excerpt)}</span></div>
        <div class="meta-item"><strong>Category</strong><span>${esc(post.category)}</span></div>
        <div class="meta-item"><strong>Tags</strong><span>${esc(tags)}</span></div>
        <div class="meta-item"><strong>Image Prompt</strong><span>${esc(post.image_prompt)}</span></div>
      </div>
      ${post.social_linkedin ? '<div class="social-box"><strong>LinkedIn:</strong> ' + esc(post.social_linkedin) + '</div>' : ""}
      ${post.social_twitter ? '<div class="social-box"><strong>Twitter/X:</strong> ' + esc(post.social_twitter) + '</div>' : ""}
      ${post.image_url ? '<div class="article-preview" style="padding:0;overflow:hidden"><img src="' + esc(post.image_url) + '" alt="' + esc(post.title) + '" style="width:100%;height:300px;object-fit:cover;border-radius:var(--radius) var(--radius) 0 0"></div>' : ''}
      <div class="article-preview"><h2>Article Preview</h2><div class="article-content">${markdownToHtml(post.content)}</div></div>
      ${isPending ? `
      <div class="review-actions">
        <form method="POST" action="/posts/${post.id}/approve" style="display:inline"><button type="submit" class="btn btn-primary btn-large">Approve &amp; Publish</button></form>
        <form method="POST" action="/posts/${post.id}/reject" style="display:inline"><button type="submit" class="btn btn-danger btn-large">Reject</button></form>
      </div>` : ""}
      ${post.publish_status ? '<div class="social-box"><strong>Status:</strong> ' + esc(post.publish_status) + '</div>' : ''}
      ${post.published_url ? '<p class="published-link">Published at <a href="' + esc(post.published_url) + '" target="_blank">' + esc(post.published_url) + '</a></p>' : ""}
    </div>
  `));
});

app.post("/posts/:id/approve", async (req, res) => {
  const sites = getSites();
  const posts = getPosts();
  const idx = posts.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).send("Not found");
  const post = posts[idx];
  const site = sites.find(s => s.id === post.site_id);

  let publishedUrl = "";
  let publishStatus = "approved";
  if (site && site.publish_endpoint) {
    const payload = {
      title: post.title, slug: post.slug, excerpt: post.excerpt,
      content: post.html_content || markdownToHtml(post.content),
      image_url: post.image_url || "",
      image_alt: post.image_alt || post.title,
      meta_title: post.meta_title || post.title,
      meta_description: post.meta_description || post.excerpt,
      tags: post.tags || [],
      category: post.category || "",
      author_name: (site ? site.name : "Blog") + " Team"
    };
    try {
      const r = await publishToApi(site.publish_endpoint, site.publish_api_key, payload);
      if (r.success) { publishedUrl = r.url || (site.domain.replace(/\/$/, "") + (site.blog_path || "/blog") + "/" + (r.slug || post.slug)); publishStatus = "published to API"; }
      else { publishStatus = "approved (API error: " + r.error + ")"; }
    } catch (e) { publishStatus = "approved (API error: " + e.message + ")"; }
  } else {
    publishStatus = "approved (no API endpoint — configure in site settings to auto-publish)";
  }

  posts[idx].status = publishedUrl ? "published" : "approved";
  posts[idx].published_url = publishedUrl;
  posts[idx].publish_status = publishStatus;
  posts[idx].published_at = new Date().toISOString();
  savePosts(posts);

  // Only set auto_approved if we actually published successfully via API
  if (site && publishedUrl) { const si = sites.findIndex(s => s.id === site.id); if (si !== -1) { sites[si].auto_approved = true; saveSites(sites); } }
  res.redirect("/posts/" + req.params.id);
});

app.post("/posts/:id/reject", (req, res) => {
  const posts = getPosts();
  const idx = posts.findIndex(p => p.id === req.params.id);
  if (idx !== -1) { posts[idx].status = "rejected"; posts[idx].reviewed_at = new Date().toISOString(); savePosts(posts); }
  res.redirect("/posts/" + req.params.id);
});

// ---------------------------------------------------------------------------
// API endpoints (used by generation script)
// ---------------------------------------------------------------------------
app.get("/api/version", (req, res) => { res.json({ version: "2.0.0", hasGenerate: true }); });

// Regenerate images for all posts that have expired DALL-E URLs
app.post("/api/fix-images", async (req, res) => {
  const posts = getPosts();
  const sites = getSites();
  let fixed = 0;
  for (let i = 0; i < posts.length; i++) {
    const post = posts[i];
    // Skip if already using stored image or no image prompt
    if (post.image_url && post.image_url.includes("/stored-images/")) continue;
    if (!post.image_prompt && !post.title) continue;

    try {
      const dalleUrl = await openaiImageGenerate(post.image_prompt || post.title);
      const filename = await downloadAndStoreImage(dalleUrl);
      const permanentUrl = getStoredImageUrl(filename, req);
      posts[i].image_url = permanentUrl;

      // Also update on Synthera if published — try PUT first (update), fall back to POST
      const site = sites.find(s => s.id === post.site_id);
      if (site && site.publish_endpoint && post.status === "published") {
        const payload = {
          title: post.title, slug: post.slug, excerpt: post.excerpt,
          content: post.html_content || markdownToHtml(post.content),
          image_url: permanentUrl, author_name: (site.name || "Blog") + " Team"
        };
        try {
          // Try PUT to update existing post by slug
          const putEndpoint = site.publish_endpoint.replace(/\/?$/, "/") + post.slug;
          let r = await publishToApi(putEndpoint, site.publish_api_key, payload, "PUT");
          if (!r.success) {
            // Fall back to POST (some APIs upsert on same slug)
            r = await publishToApi(site.publish_endpoint, site.publish_api_key, payload);
          }
          console.log("[Fix Images] " + post.title + ": " + (r.success ? "updated" : r.error));
        } catch {}
      }
      fixed++;
    } catch (err) {
      console.error("Fix image failed for " + post.title + ":", err.message);
    }
  }
  savePosts(posts);
  res.json({ fixed, total: posts.length });
});

// Rewrite all published posts with simpler, more readable content and update on site
app.post("/api/rewrite-all", async (req, res) => {
  const posts = getPosts();
  const sites = getSites();
  const results = [];
  for (let i = 0; i < posts.length; i++) {
    const post = posts[i];
    if (post.status !== "published") continue;
    const site = sites.find(s => s.id === post.site_id);
    if (!site) continue;

    try {
      const rewritten = await aiRequest(`Rewrite this blog post to be much simpler and easier to read.

ORIGINAL TITLE: ${post.title}
ORIGINAL CONTENT:
${post.content}

COMPANY: ${site.name}
NICHE: ${site.niche}
TONE: ${site.tone || "professional but friendly"}

REWRITING RULES — VERY IMPORTANT:
- Keep the SAME topic and key points, but make it WAY simpler.
- Write for a normal person, NOT a technical audience. Use everyday language.
- Keep sentences short (under 20 words). Keep paragraphs to 2-3 sentences max.
- NO jargon or buzzwords. NO phrases like "In today's rapidly evolving landscape", "leveraging", "cutting-edge", "game-changer", "revolutionize", "transform", "unlock".
- Be direct and practical. Give real examples and actionable tips.
- Use ## headings to break content into 5-6 scannable sections.
- Use bullet points for lists — keep each bullet to one short line.
- Start with a clear hook. End with a 1-2 sentence call to action.
- Tone: helpful friend explaining something, not a corporate whitepaper.
- Target ~600-800 words total. Cut the fluff.

Respond in JSON:
{
  "title": "Simpler, clearer title (60 chars max)",
  "metaDescription": "Plain-English meta description (155 chars max)",
  "excerpt": "1-2 sentence simple summary",
  "content": "Rewritten blog post in markdown. ~800 words max."
}`);

      // Update post data
      posts[i].title = rewritten.title || post.title;
      posts[i].meta_description = rewritten.metaDescription || post.meta_description;
      posts[i].excerpt = rewritten.excerpt || post.excerpt;
      posts[i].content = rewritten.content || post.content;
      posts[i].html_content = markdownToHtml(rewritten.content || post.content);

      // Update on Synthera via PUT
      if (site.publish_endpoint) {
        const putEndpoint = site.publish_endpoint.replace(/\/?$/, "/") + post.slug;
        const payload = {
          title: posts[i].title, slug: post.slug, excerpt: posts[i].excerpt,
          content: posts[i].html_content, image_url: post.image_url,
          image_alt: post.image_alt || posts[i].title,
          meta_title: post.meta_title || posts[i].title,
          meta_description: posts[i].meta_description || posts[i].excerpt,
          tags: post.tags || [],
          category: post.category || "",
          author_name: (site.name || "Blog") + " Team"
        };
        const r = await publishToApi(putEndpoint, site.publish_api_key, payload, "PUT");
        results.push({ slug: post.slug, title: posts[i].title, success: r.success, error: r.error || null });
      }
    } catch (err) {
      results.push({ slug: post.slug, title: post.title, success: false, error: err.message });
    }
  }
  savePosts(posts);
  res.json({ rewritten: results.filter(r => r.success).length, total: results.length, results });
});

// Force re-publish stored image URLs to the target site via PUT
app.post("/api/republish-images", async (req, res) => {
  const posts = getPosts();
  const sites = getSites();
  const results = [];
  for (const post of posts) {
    if (!post.image_url || !post.image_url.includes("/stored-images/")) continue;
    if (post.status !== "published") continue;
    const site = sites.find(s => s.id === post.site_id);
    if (!site || !site.publish_endpoint) continue;
    const putEndpoint = site.publish_endpoint.replace(/\/?$/, "/") + post.slug;
    const payload = { image_url: post.image_url };
    try {
      const r = await publishToApi(putEndpoint, site.publish_api_key, payload, "PUT");
      results.push({ title: post.title, slug: post.slug, success: r.success, error: r.error || null });
    } catch (e) {
      results.push({ title: post.title, slug: post.slug, success: false, error: e.message });
    }
  }
  res.json({ updated: results.filter(r => r.success).length, results });
});

app.get("/api/sites", (req, res) => {
  res.json(getSites().filter(s => s.status === "ready"));
});

app.post("/api/posts", async (req, res) => {
  const { site_id, post } = req.body;
  const sites = getSites();
  const site = sites.find(s => s.id === site_id);
  if (!site) return res.status(404).json({ error: "Site not found" });

  const id = crypto.randomUUID();
  let status = "pending_review";
  let publishedUrl = "";

  const htmlContent = markdownToHtml(post.content);
  if (site.auto_approved && site.publish_endpoint) {
    const payload = { title: post.title, slug: post.slug, excerpt: post.excerpt, content: htmlContent, image_url: post.imageUrl || "", author_name: site.name + " Team" };
    try { const r = await publishToApi(site.publish_endpoint, site.publish_api_key, payload); if (r.success) { status = "published"; publishedUrl = r.url || site.domain + "/blog/" + post.slug; } } catch {}
  }

  const posts = getPosts();
  posts.push({
    id, site_id, title: post.title, slug: post.slug,
    meta_title: post.metaTitle, meta_description: post.metaDescription,
    excerpt: post.excerpt, category: post.category,
    tags: post.tags || [], content: post.content,
    html_content: htmlContent,
    image_url: post.imageUrl || "",
    image_prompt: post.imagePrompt,
    social_linkedin: (post.socialSnippets || {}).linkedin || "",
    social_twitter: (post.socialSnippets || {}).twitter || "",
    status, published_url: publishedUrl,
    generated_at: new Date().toISOString(),
  });
  savePosts(posts);
  res.json({ id, status, publishedUrl });
});

// ---------------------------------------------------------------------------
// API: Trigger generation for all sites (called by n8n / GitHub Actions)
// ---------------------------------------------------------------------------
app.post("/api/generate", async (req, res) => {
  const sites = getSites().filter(s => s.status === "ready");
  if (sites.length === 0) return res.json({ message: "No sites configured", results: [] });

  console.log("=== Auto Generate triggered for " + sites.length + " site(s) ===");
  res.json({ message: "Generation started for " + sites.length + " site(s)", sites: sites.map(s => s.name) });

  // Run generation in background for each site
  for (const site of sites) {
    const genId = "gen-" + site.id;
    analysisProgress[genId] = { steps: [], status: "analyzing" };

    try {
      updateProgress(genId, "Crawling", "Fetching latest content from " + site.domain + "...");
      let homepageText = "";
      try {
        const html = await fetchUrl(site.domain);
        homepageText = htmlToText(html).substring(0, 3000);
      } catch {}

      let blogSamples = [];
      const blogUrl = site.domain.replace(/\/$/, "") + (site.blog_path || "/blog");
      try {
        const blogHtml = await fetchUrl(blogUrl);
        const linkRegex = /<a[^>]*href="([^"]*)"[^>]*>/gi;
        const links = [];
        let m;
        while ((m = linkRegex.exec(blogHtml)) !== null) {
          let href = m[1];
          if (href.startsWith("/")) href = site.domain.replace(/\/$/, "") + href;
          if (href.startsWith(site.domain) && href.includes((site.blog_path || "/blog") + "/")) links.push(href);
        }
        for (const link of [...new Set(links)].slice(0, 3)) {
          try { blogSamples.push(htmlToText(await fetchUrl(link)).substring(0, 1500)); } catch {}
        }
      } catch {}
      updateProgress(genId, "Content Gathered", "Read homepage + " + blogSamples.length + " blog posts");

      const existingPosts = getPosts().filter(p => p.site_id === site.id).map(p => p.title);
      updateProgress(genId, "Generating", "AI is writing a blog post...");

      const post = await aiRequest(`You are an expert SEO blog writer. Generate a complete blog post for this website.

WEBSITE: ${site.domain}
COMPANY: ${site.name}
NICHE: ${site.niche}
TONE: ${site.tone}
BRAND VOICE: ${site.brand_voice}
CONTENT STYLE: ${site.content_style}
TARGET KEYWORDS: ${(site.target_keywords || []).join(", ")}

HOMEPAGE CONTENT (for context):
${homepageText}

EXISTING BLOG POSTS (for style reference, DO NOT repeat these topics):
${blogSamples.map((s, i) => "--- Post " + (i + 1) + " ---\n" + s).join("\n\n")}

ALREADY PUBLISHED TITLES (DO NOT repeat or write anything similar):
${existingPosts.join("\n")}

TOPIC DIVERSITY — CRITICAL:
You MUST pick a topic that is genuinely DIFFERENT from the titles above. Do NOT just rephrase the same ideas.
Think beyond the obvious. Consider these angles for variety:
- Industry trends or news relevant to the niche
- Common mistakes businesses make (and how to avoid them)
- Behind-the-scenes / how things actually work
- Cost comparisons, budgeting, or ROI discussions
- Case study style: a specific problem and how it was solved
- Beginner guides or "what you need to know before..."
- Myths vs reality in the industry
- Hiring, team building, or workflow tips related to the niche
- Comparisons (e.g. option A vs option B)
- Seasonal or timely topics

Pick ONE angle from above (or come up with your own unique angle) that has NOT been covered yet.

Write a ~800 word blog post on this fresh topic.

WRITING RULES — VERY IMPORTANT:
- Write for a normal person, NOT a technical audience. Use simple, everyday language.
- Keep sentences short (under 20 words). Keep paragraphs to 2-3 sentences max.
- NO jargon, buzzwords, or filler phrases like "In today's rapidly evolving landscape" or "leveraging cutting-edge solutions".
- Be direct and practical. Give real examples and actionable tips.
- Use ## headings to break content into scannable sections (5-6 sections).
- Use bullet points for lists — keep each bullet to one line.
- Start with a hook that states the problem or benefit clearly.
- End with a short, clear call to action (1-2 sentences).
- The tone should feel like a helpful friend explaining something, not a corporate whitepaper.
- DO NOT use the word "revolutionize", "transform", "leverage", "cutting-edge", "game-changer", or "unlock".
- DO NOT start the title with "How". Vary your title formats.

Respond in this exact JSON format:
{
  "title": "Blog post title (60 chars max, include primary keyword naturally)",
  "slug": "keyword-rich-url-slug (3-5 words, include main keyword)",
  "metaTitle": "SEO meta title (60 chars max, primary keyword near the start)",
  "metaDescription": "Compelling meta description (150-155 chars, include keyword, end with a reason to click)",
  "excerpt": "1-2 sentence plain-English summary that makes people want to read more",
  "category": "Main category",
  "tags": ["tag1", "tag2", "tag3", "tag4", "tag5"],
  "content": "Full blog post in markdown. ~800 words. Must include: primary keyword in first paragraph, ## headings with related keywords, internal context about the company, short paragraphs, bullet points. End with a clear CTA.",
  "imageAlt": "Descriptive alt text for the hero image (include primary keyword, describe what the image shows, under 125 chars)",
  "imagePrompt": "A professional, modern image relevant to this specific article topic. Be specific about the scene — include details about setting, objects, people, and mood. Do NOT include any text or words in the image. Style: clean, professional, high-quality photograph look.",
  "socialSnippets": {
    "linkedin": "LinkedIn post to promote this article (2-3 sentences)",
    "twitter": "Tweet to promote this article (under 280 chars)"
  },
  "faq": [
    {"question": "Natural question people would search for about this topic", "answer": "Clear, concise answer (2-3 sentences)"},
    {"question": "Another common question", "answer": "Answer"},
    {"question": "Third question", "answer": "Answer"}
  ]
}`);

      updateProgress(genId, "Post Generated", post.title);

      // Generate image and store permanently
      let imageUrl = "";
      try {
        const dalleUrl = await openaiImageGenerate(post.imagePrompt || post.title);
        const filename = await downloadAndStoreImage(dalleUrl, post.slug);
        imageUrl = getStoredImageUrl(filename);
      } catch {
        const keywords = (site.target_keywords || []).length > 0 ? site.target_keywords : [site.niche || "technology"];
        imageUrl = generateImageUrl(keywords);
      }

      const htmlContent = markdownToHtml(post.content);
      const postId = crypto.randomUUID();
      let status = "pending_review";
      let publishedUrl = "";

      if (site.auto_approved && site.publish_endpoint) {
        const payload = {
          title: post.title, slug: post.slug, excerpt: post.excerpt,
          content: htmlContent, image_url: imageUrl,
          image_alt: post.imageAlt || post.title,
          meta_title: post.metaTitle || post.title,
          meta_description: post.metaDescription || post.excerpt,
          tags: post.tags || [],
          category: post.category || "",
          author_name: site.name + " Team"
        };
        try {
          const r = await publishToApi(site.publish_endpoint, site.publish_api_key, payload);
          if (r.success) {
            status = "published";
            publishedUrl = r.url || (site.domain.replace(/\/$/, "") + (site.blog_path || "/blog") + "/" + (r.slug || post.slug));
          }
        } catch {}
      }

      const posts = getPosts();
      posts.push({
        id: postId, site_id: site.id, title: post.title, slug: post.slug,
        meta_title: post.metaTitle, meta_description: post.metaDescription,
        excerpt: post.excerpt, category: post.category,
        tags: post.tags || [], content: post.content,
        html_content: htmlContent, image_url: imageUrl,
        image_alt: post.imageAlt || post.title,
        image_prompt: post.imagePrompt,
        social_linkedin: (post.socialSnippets || {}).linkedin || "",
        social_twitter: (post.socialSnippets || {}).twitter || "",
        faq: post.faq || [],
        status, published_url: publishedUrl,
        generated_at: new Date().toISOString(),
      });
      savePosts(posts);

      console.log("[Auto] " + site.name + ": " + post.title + " — " + status);
      analysisProgress[genId].status = "done";

    } catch (err) {
      console.error("[Auto] " + site.name + " failed:", err.message);
      analysisProgress[genId].status = "done";
    }
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, "0.0.0.0", () => {
  console.log("Dashboard v2.0 running on http://0.0.0.0:" + PORT);
});

process.on("uncaughtException", (err) => { console.error("UNCAUGHT:", err); });
process.on("unhandledRejection", (err) => { console.error("UNHANDLED:", err); });
