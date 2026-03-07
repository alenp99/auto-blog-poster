const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const https = require("https");
const http = require("http");

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

// ---------------------------------------------------------------------------
// JSON file database
// ---------------------------------------------------------------------------
const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

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

function publishToApi(endpoint, apiKey, payload) {
  return new Promise((resolve) => {
    const url = new URL(endpoint);
    const client = url.protocol === "https:" ? https : http;
    const body = JSON.stringify(payload);
    const headers = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) };
    if (apiKey) headers["Authorization"] = "Bearer " + apiKey;
    const req = client.request({ hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: "POST", headers }, (res) => {
      let data = ""; res.on("data", (c) => data += c);
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          let postUrl = ""; try { const p = JSON.parse(data); postUrl = p.url || p.slug || ""; } catch {} resolve({ success: true, url: postUrl });
        } else { resolve({ success: false, error: "HTTP " + res.statusCode }); }
      });
    });
    req.on("error", (err) => resolve({ success: false, error: err.message }));
    req.write(body); req.end();
  });
}

function markdownToHtml(md) {
  if (!md) return "";
  return md
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/^### (.*$)/gm, "<h3>$1</h3>").replace(/^## (.*$)/gm, "<h2>$1</h2>").replace(/^# (.*$)/gm, "<h1>$1</h1>")
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>").replace(/\*(.*?)\*/g, "<em>$1</em>")
    .replace(/^- (.*$)/gm, "<li>$1</li>").replace(/^\d+\. (.*$)/gm, "<li>$1</li>")
    .replace(/\n\n/g, "</p><p>").replace(/^(?!<[hulo])(.+)$/gm, "<p>$1</p>").replace(/<p><\/p>/g, "");
}

// ---------------------------------------------------------------------------
// Crawl & analyze a website with Gemini
// ---------------------------------------------------------------------------
async function analyzeWebsite(domain) {
  console.log("Analyzing " + domain + "...");

  let homepageHtml = "";
  try { homepageHtml = await fetchUrl(domain); } catch (e) { console.error("Fetch failed:", e.message); }

  const title = extractTitle(homepageHtml);
  const description = extractMetaDescription(homepageHtml);
  const homepageText = htmlToText(homepageHtml).substring(0, 5000);

  // Try to find blog
  let blogHtml = "";
  let blogPath = "/blog";
  for (const tryPath of ["/blog", "/blogs", "/articles", "/news", "/resources"]) {
    try {
      blogHtml = await fetchUrl(domain.replace(/\/$/, "") + tryPath);
      if (blogHtml.length > 500) { blogPath = tryPath; break; }
    } catch {}
  }

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
  const blogSamples = [];
  for (const link of uniqueBlogLinks) {
    try { blogSamples.push(htmlToText(await fetchUrl(link)).substring(0, 2000)); } catch {}
  }

  const fallback = {
    name: title || new URL(domain).hostname.replace("www.", "").split(".")[0],
    niche: description || "General",
    tone: "professional and modern",
    target_keywords: [],
    blog_path: blogPath,
    brand_voice: "Professional",
    content_style: "Standard blog format",
  };

  if (!OPENAI_API_KEY && !GEMINI_API_KEY) return fallback;

  // Ask AI to analyze
  try {
    const analysis = await aiRequest(`Analyze this website and tell me about it. Study the homepage content and any blog posts to understand the business.

WEBSITE: ${domain}
PAGE TITLE: ${title}
META DESCRIPTION: ${description}

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
  "content_style": "How articles are structured - paragraph length, heading patterns, use of lists"
}`);
    return { ...analysis, blog_path: blogPath };
  } catch (err) {
    console.error("AI analysis failed, using fallback:", err.message);
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

  // Redirect immediately — analysis happens in background
  res.redirect("/sites");

  // Crawl and analyze in background
  try {
    const analysis = await analyzeWebsite(domain);
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
        post_length: 1500,
        publish_endpoint: "",
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
  res.redirect("/sites");

  try {
    const analysis = await analyzeWebsite(sites[idx].domain);
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
  const bc = post.status === "published" ? "badge-published" : post.status === "pending_review" ? "badge-pending" : "badge-rejected";

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
      <div class="article-preview"><h2>Article Preview</h2><div class="article-content">${markdownToHtml(post.content)}</div></div>
      ${isPending ? `
      <div class="review-actions">
        <form method="POST" action="/posts/${post.id}/approve" style="display:inline"><button type="submit" class="btn btn-primary btn-large">Approve &amp; Publish</button></form>
        <form method="POST" action="/posts/${post.id}/reject" style="display:inline"><button type="submit" class="btn btn-danger btn-large">Reject</button></form>
      </div>` : ""}
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

  let publishedUrl = site ? site.domain + "/blog/" + post.slug : "";
  if (site && site.publish_endpoint) {
    const payload = { title: post.title, slug: post.slug, metaTitle: post.meta_title, metaDescription: post.meta_description, excerpt: post.excerpt, content: post.content, category: post.category, tags: post.tags || [], date: new Date().toISOString().split("T")[0], imagePrompt: post.image_prompt, status: "published" };
    try { const r = await publishToApi(site.publish_endpoint, site.publish_api_key, payload); if (r.success && r.url) publishedUrl = r.url; } catch {}
  }

  posts[idx].status = "published";
  posts[idx].published_url = publishedUrl;
  posts[idx].published_at = new Date().toISOString();
  savePosts(posts);

  if (site) { const si = sites.findIndex(s => s.id === site.id); if (si !== -1) { sites[si].auto_approved = true; saveSites(sites); } }
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

  if (site.auto_approved && site.publish_endpoint) {
    const payload = { title: post.title, slug: post.slug, metaTitle: post.metaTitle, metaDescription: post.metaDescription, excerpt: post.excerpt, content: post.content, category: post.category, tags: post.tags, date: new Date().toISOString().split("T")[0], imagePrompt: post.imagePrompt, status: "published" };
    try { const r = await publishToApi(site.publish_endpoint, site.publish_api_key, payload); if (r.success) { status = "published"; publishedUrl = r.url || site.domain + "/blog/" + post.slug; } } catch {}
  } else if (site.auto_approved) {
    status = "published";
    publishedUrl = site.domain + "/blog/" + post.slug;
  }

  const posts = getPosts();
  posts.push({
    id, site_id, title: post.title, slug: post.slug,
    meta_title: post.metaTitle, meta_description: post.metaDescription,
    excerpt: post.excerpt, category: post.category,
    tags: post.tags || [], content: post.content,
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
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, "0.0.0.0", () => {
  console.log("Dashboard running on http://0.0.0.0:" + PORT);
});
