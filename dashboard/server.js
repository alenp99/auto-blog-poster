const express = require("express");
const path = require("path");
const Database = require("better-sqlite3");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const GITHUB_REPO = process.env.GITHUB_REPO || "alenp99/auto-blog-poster";
const GITHUB_PAT = process.env.GITHUB_PAT || "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

// ---------------------------------------------------------------------------
// Database setup
// ---------------------------------------------------------------------------
const dbPath = path.join(__dirname, "data", "dashboard.db");
require("fs").mkdirSync(path.join(__dirname, "data"), { recursive: true });
const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS sites (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    domain TEXT NOT NULL,
    blog_path TEXT DEFAULT '/blog',
    publish_endpoint TEXT,
    publish_api_key TEXT,
    niche TEXT,
    tone TEXT DEFAULT 'professional',
    target_keywords TEXT DEFAULT '[]',
    post_length INTEGER DEFAULT 1500,
    auto_approved INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL,
    title TEXT NOT NULL,
    slug TEXT NOT NULL,
    meta_title TEXT,
    meta_description TEXT,
    excerpt TEXT,
    category TEXT,
    tags TEXT DEFAULT '[]',
    content TEXT,
    image_prompt TEXT,
    social_linkedin TEXT,
    social_twitter TEXT,
    status TEXT DEFAULT 'pending_review',
    published_url TEXT,
    generated_at TEXT DEFAULT (datetime('now')),
    reviewed_at TEXT,
    published_at TEXT,
    FOREIGN KEY (site_id) REFERENCES sites(id)
  );
`);

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// Simple HTML template engine
function render(title, body, toast = "") {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - Auto Blog Dashboard</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <nav>
    <div class="nav-inner">
      <a href="/" class="logo">Auto Blog Publisher</a>
      <div class="nav-links">
        <a href="/">Dashboard</a>
        <a href="/sites">Sites</a>
        <a href="/sites/add">Add Site</a>
        <a href="/posts">All Posts</a>
      </div>
    </div>
  </nav>
  ${toast ? `<div class="toast">${toast}</div>` : ""}
  <main>${body}</main>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Routes: Dashboard
// ---------------------------------------------------------------------------
app.get("/", (req, res) => {
  const sites = db.prepare("SELECT * FROM sites ORDER BY created_at DESC").all();
  const pendingPosts = db.prepare("SELECT posts.*, sites.name as site_name FROM posts JOIN sites ON posts.site_id = sites.id WHERE posts.status = 'pending_review' ORDER BY posts.generated_at DESC").all();
  const publishedCount = db.prepare("SELECT COUNT(*) as count FROM posts WHERE status = 'published'").get();
  const pendingCount = db.prepare("SELECT COUNT(*) as count FROM posts WHERE status = 'pending_review'").get();

  const pendingHtml = pendingPosts.length > 0
    ? pendingPosts.map(p => `
      <div class="post-card pending">
        <div class="post-header">
          <span class="badge badge-pending">Pending Review</span>
          <span class="site-tag">${p.site_name}</span>
        </div>
        <h3>${p.title}</h3>
        <p class="excerpt">${p.excerpt || ""}</p>
        <div class="post-meta">
          <span>Category: ${p.category || "N/A"}</span>
          <span>Generated: ${p.generated_at}</span>
        </div>
        <div class="post-actions">
          <a href="/posts/${p.id}" class="btn btn-primary">Review</a>
        </div>
      </div>`).join("")
    : '<p class="empty-state">No posts pending review. All clear!</p>';

  res.send(render("Dashboard", `
    <div class="dashboard">
      <h1>Dashboard</h1>
      <div class="stats">
        <div class="stat-card">
          <div class="stat-number">${sites.length}</div>
          <div class="stat-label">Sites</div>
        </div>
        <div class="stat-card">
          <div class="stat-number">${pendingCount.count}</div>
          <div class="stat-label">Pending Review</div>
        </div>
        <div class="stat-card">
          <div class="stat-number">${publishedCount.count}</div>
          <div class="stat-label">Published</div>
        </div>
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
  const sites = db.prepare("SELECT sites.*, (SELECT COUNT(*) FROM posts WHERE posts.site_id = sites.id) as post_count FROM sites ORDER BY created_at DESC").all();

  const siteCards = sites.length > 0
    ? sites.map(s => `
      <div class="site-card">
        <div class="site-header">
          <h3>${s.name}</h3>
          ${s.auto_approved ? '<span class="badge badge-auto">Auto-publish</span>' : '<span class="badge badge-review">Review first</span>'}
        </div>
        <p class="domain"><a href="${s.domain}" target="_blank">${s.domain}</a></p>
        <p class="niche">${s.niche || ""}</p>
        <div class="site-meta">
          <span>${s.post_count} post(s)</span>
          <span>Tone: ${s.tone}</span>
        </div>
        <div class="site-actions">
          <a href="/sites/${s.id}" class="btn btn-secondary">Edit</a>
          <form method="POST" action="/sites/${s.id}/delete" style="display:inline" onsubmit="return confirm('Delete this site?')">
            <button type="submit" class="btn btn-danger">Delete</button>
          </form>
        </div>
      </div>`).join("")
    : '<p class="empty-state">No sites configured yet. <a href="/sites/add">Add your first site</a></p>';

  res.send(render("Sites", `
    <div class="sites-page">
      <div class="page-header">
        <h1>Sites</h1>
        <a href="/sites/add" class="btn btn-primary">+ Add Site</a>
      </div>
      <div class="site-list">${siteCards}</div>
    </div>
  `));
});

app.get("/sites/add", (req, res) => {
  res.send(render("Add Site", `
    <div class="form-page">
      <h1>Add Website</h1>
      <form method="POST" action="/sites" class="site-form">
        <div class="form-group">
          <label>Website Name *</label>
          <input type="text" name="name" required placeholder="e.g. Synthera">
        </div>
        <div class="form-group">
          <label>Domain *</label>
          <input type="url" name="domain" required placeholder="https://www.example.com">
        </div>
        <div class="form-group">
          <label>Blog Path</label>
          <input type="text" name="blog_path" value="/blog" placeholder="/blog">
        </div>
        <div class="form-group">
          <label>Blog API Endpoint</label>
          <input type="url" name="publish_endpoint" placeholder="https://www.example.com/api/blog/create">
          <small>The API endpoint where blog posts will be published</small>
        </div>
        <div class="form-group">
          <label>Blog API Key</label>
          <input type="text" name="publish_api_key" placeholder="Your API key for publishing">
        </div>
        <div class="form-group">
          <label>Niche / Topics *</label>
          <input type="text" name="niche" required placeholder="e.g. AI automation, SaaS platforms">
        </div>
        <div class="form-group">
          <label>Writing Tone</label>
          <select name="tone">
            <option value="professional and modern">Professional & Modern</option>
            <option value="informative and engaging">Informative & Engaging</option>
            <option value="casual and friendly">Casual & Friendly</option>
            <option value="technical and authoritative">Technical & Authoritative</option>
            <option value="conversational">Conversational</option>
          </select>
        </div>
        <div class="form-group">
          <label>Target Keywords (comma-separated)</label>
          <input type="text" name="target_keywords" placeholder="AI automation, voice agents, customer support">
        </div>
        <div class="form-group">
          <label>Post Length (words)</label>
          <input type="number" name="post_length" value="1500" min="800" max="3000">
        </div>
        <button type="submit" class="btn btn-primary btn-large">Add Website</button>
      </form>
    </div>
  `));
});

app.post("/sites", (req, res) => {
  const id = crypto.randomUUID();
  const keywords = req.body.target_keywords
    ? JSON.stringify(req.body.target_keywords.split(",").map(k => k.trim()).filter(Boolean))
    : "[]";

  db.prepare(`
    INSERT INTO sites (id, name, domain, blog_path, publish_endpoint, publish_api_key, niche, tone, target_keywords, post_length, auto_approved)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `).run(
    id,
    req.body.name,
    req.body.domain,
    req.body.blog_path || "/blog",
    req.body.publish_endpoint || null,
    req.body.publish_api_key || null,
    req.body.niche,
    req.body.tone || "professional and modern",
    keywords,
    parseInt(req.body.post_length) || 1500
  );

  // Sync to sites.json for the generation script
  syncSitesJson();

  res.redirect("/sites");
});

app.get("/sites/:id", (req, res) => {
  const site = db.prepare("SELECT * FROM sites WHERE id = ?").get(req.params.id);
  if (!site) return res.status(404).send(render("Not Found", "<h1>Site not found</h1>"));

  const keywords = JSON.parse(site.target_keywords || "[]").join(", ");

  res.send(render("Edit " + site.name, `
    <div class="form-page">
      <h1>Edit: ${site.name}</h1>
      <form method="POST" action="/sites/${site.id}/update" class="site-form">
        <div class="form-group">
          <label>Website Name *</label>
          <input type="text" name="name" required value="${site.name}">
        </div>
        <div class="form-group">
          <label>Domain *</label>
          <input type="url" name="domain" required value="${site.domain}">
        </div>
        <div class="form-group">
          <label>Blog Path</label>
          <input type="text" name="blog_path" value="${site.blog_path || "/blog"}">
        </div>
        <div class="form-group">
          <label>Blog API Endpoint</label>
          <input type="url" name="publish_endpoint" value="${site.publish_endpoint || ""}">
        </div>
        <div class="form-group">
          <label>Blog API Key</label>
          <input type="text" name="publish_api_key" value="${site.publish_api_key || ""}">
        </div>
        <div class="form-group">
          <label>Niche / Topics *</label>
          <input type="text" name="niche" required value="${site.niche || ""}">
        </div>
        <div class="form-group">
          <label>Writing Tone</label>
          <select name="tone">
            <option value="professional and modern" ${site.tone === "professional and modern" ? "selected" : ""}>Professional & Modern</option>
            <option value="informative and engaging" ${site.tone === "informative and engaging" ? "selected" : ""}>Informative & Engaging</option>
            <option value="casual and friendly" ${site.tone === "casual and friendly" ? "selected" : ""}>Casual & Friendly</option>
            <option value="technical and authoritative" ${site.tone === "technical and authoritative" ? "selected" : ""}>Technical & Authoritative</option>
            <option value="conversational" ${site.tone === "conversational" ? "selected" : ""}>Conversational</option>
          </select>
        </div>
        <div class="form-group">
          <label>Target Keywords (comma-separated)</label>
          <input type="text" name="target_keywords" value="${keywords}">
        </div>
        <div class="form-group">
          <label>Post Length (words)</label>
          <input type="number" name="post_length" value="${site.post_length}" min="800" max="3000">
        </div>
        <button type="submit" class="btn btn-primary btn-large">Save Changes</button>
      </form>
    </div>
  `));
});

app.post("/sites/:id/update", (req, res) => {
  const keywords = req.body.target_keywords
    ? JSON.stringify(req.body.target_keywords.split(",").map(k => k.trim()).filter(Boolean))
    : "[]";

  db.prepare(`
    UPDATE sites SET name=?, domain=?, blog_path=?, publish_endpoint=?, publish_api_key=?, niche=?, tone=?, target_keywords=?, post_length=?
    WHERE id=?
  `).run(
    req.body.name, req.body.domain, req.body.blog_path || "/blog",
    req.body.publish_endpoint || null, req.body.publish_api_key || null,
    req.body.niche, req.body.tone, keywords, parseInt(req.body.post_length) || 1500,
    req.params.id
  );

  syncSitesJson();
  res.redirect("/sites");
});

app.post("/sites/:id/delete", (req, res) => {
  db.prepare("DELETE FROM posts WHERE site_id = ?").run(req.params.id);
  db.prepare("DELETE FROM sites WHERE id = ?").run(req.params.id);
  syncSitesJson();
  res.redirect("/sites");
});

// ---------------------------------------------------------------------------
// Routes: Posts
// ---------------------------------------------------------------------------
app.get("/posts", (req, res) => {
  const filter = req.query.status || "all";
  let posts;
  if (filter === "all") {
    posts = db.prepare("SELECT posts.*, sites.name as site_name FROM posts JOIN sites ON posts.site_id = sites.id ORDER BY posts.generated_at DESC").all();
  } else {
    posts = db.prepare("SELECT posts.*, sites.name as site_name FROM posts JOIN sites ON posts.site_id = sites.id WHERE posts.status = ? ORDER BY posts.generated_at DESC").all(filter);
  }

  const postRows = posts.length > 0
    ? posts.map(p => {
        const badgeClass = p.status === "published" ? "badge-published" : p.status === "pending_review" ? "badge-pending" : "badge-rejected";
        return `
        <div class="post-card ${p.status}">
          <div class="post-header">
            <span class="badge ${badgeClass}">${p.status.replace("_", " ")}</span>
            <span class="site-tag">${p.site_name}</span>
          </div>
          <h3>${p.title}</h3>
          <p class="excerpt">${p.excerpt || ""}</p>
          <div class="post-meta">
            <span>${p.category || ""}</span>
            <span>${p.generated_at}</span>
            ${p.published_url ? `<a href="${p.published_url}" target="_blank">View live</a>` : ""}
          </div>
          <div class="post-actions">
            <a href="/posts/${p.id}" class="btn btn-secondary">View</a>
          </div>
        </div>`;
      }).join("")
    : '<p class="empty-state">No posts yet. Add a site and trigger a generation run.</p>';

  res.send(render("Posts", `
    <div class="posts-page">
      <div class="page-header">
        <h1>All Posts</h1>
        <div class="filter-tabs">
          <a href="/posts" class="tab ${filter === "all" ? "active" : ""}">All</a>
          <a href="/posts?status=pending_review" class="tab ${filter === "pending_review" ? "active" : ""}">Pending</a>
          <a href="/posts?status=published" class="tab ${filter === "published" ? "active" : ""}">Published</a>
          <a href="/posts?status=rejected" class="tab ${filter === "rejected" ? "active" : ""}">Rejected</a>
        </div>
      </div>
      <div class="post-list">${postRows}</div>
    </div>
  `));
});

app.get("/posts/:id", (req, res) => {
  const post = db.prepare("SELECT posts.*, sites.name as site_name, sites.domain as site_domain FROM posts JOIN sites ON posts.site_id = sites.id WHERE posts.id = ?").get(req.params.id);
  if (!post) return res.status(404).send(render("Not Found", "<h1>Post not found</h1>"));

  const tags = JSON.parse(post.tags || "[]").join(", ");
  const isPending = post.status === "pending_review";

  res.send(render(post.title, `
    <div class="post-detail">
      <div class="post-detail-header">
        <a href="/posts" class="back-link">Back to posts</a>
        <div class="post-detail-meta">
          <span class="badge ${post.status === "published" ? "badge-published" : post.status === "pending_review" ? "badge-pending" : "badge-rejected"}">${post.status.replace("_", " ")}</span>
          <span class="site-tag">${post.site_name}</span>
        </div>
      </div>

      <h1>${post.title}</h1>

      <div class="meta-grid">
        <div class="meta-item"><strong>Slug</strong><span>${post.slug}</span></div>
        <div class="meta-item"><strong>Meta Title</strong><span>${post.meta_title || ""}</span></div>
        <div class="meta-item"><strong>Meta Description</strong><span>${post.meta_description || ""}</span></div>
        <div class="meta-item"><strong>Excerpt</strong><span>${post.excerpt || ""}</span></div>
        <div class="meta-item"><strong>Category</strong><span>${post.category || ""}</span></div>
        <div class="meta-item"><strong>Tags</strong><span>${tags}</span></div>
        <div class="meta-item"><strong>Image Prompt</strong><span>${post.image_prompt || ""}</span></div>
      </div>

      ${post.social_linkedin ? `<div class="social-box"><strong>LinkedIn:</strong> ${post.social_linkedin}</div>` : ""}
      ${post.social_twitter ? `<div class="social-box"><strong>Twitter/X:</strong> ${post.social_twitter}</div>` : ""}

      <div class="article-preview">
        <h2>Article Preview</h2>
        <div class="article-content">${markdownToHtml(post.content || "")}</div>
      </div>

      ${isPending ? `
      <div class="review-actions">
        <form method="POST" action="/posts/${post.id}/approve" style="display:inline">
          <button type="submit" class="btn btn-primary btn-large">Approve & Publish</button>
        </form>
        <form method="POST" action="/posts/${post.id}/reject" style="display:inline">
          <button type="submit" class="btn btn-danger btn-large">Reject</button>
        </form>
      </div>` : ""}

      ${post.published_url ? `<p class="published-link">Published: <a href="${post.published_url}" target="_blank">${post.published_url}</a></p>` : ""}
    </div>
  `));
});

app.post("/posts/:id/approve", async (req, res) => {
  const post = db.prepare("SELECT posts.*, sites.publish_endpoint, sites.publish_api_key, sites.domain, sites.id as sid FROM posts JOIN sites ON posts.site_id = sites.id WHERE posts.id = ?").get(req.params.id);
  if (!post) return res.status(404).send("Not found");

  let publishedUrl = "";
  let status = "published";

  // Try to publish to API
  if (post.publish_endpoint) {
    try {
      const payload = {
        title: post.title,
        slug: post.slug,
        metaTitle: post.meta_title,
        metaDescription: post.meta_description,
        excerpt: post.excerpt,
        content: post.content,
        category: post.category,
        tags: JSON.parse(post.tags || "[]"),
        date: new Date().toISOString().split("T")[0],
        imagePrompt: post.image_prompt,
        status: "published",
      };

      const apiResult = await publishToApi(post.publish_endpoint, post.publish_api_key, payload);
      if (apiResult.success) {
        publishedUrl = apiResult.url || `${post.domain}/blog/${post.slug}`;
      } else {
        console.error("Publish failed:", apiResult.error);
        publishedUrl = `${post.domain}/blog/${post.slug}`;
      }
    } catch (err) {
      console.error("Publish error:", err);
      publishedUrl = `${post.domain}/blog/${post.slug}`;
    }
  } else {
    publishedUrl = `${post.domain}/blog/${post.slug}`;
  }

  db.prepare("UPDATE posts SET status = ?, published_url = ?, published_at = datetime('now'), reviewed_at = datetime('now') WHERE id = ?")
    .run(status, publishedUrl, req.params.id);

  // Mark site as auto-approved for future posts
  db.prepare("UPDATE sites SET auto_approved = 1 WHERE id = ?").run(post.sid);
  syncSitesJson();

  res.redirect("/posts/" + req.params.id);
});

app.post("/posts/:id/reject", (req, res) => {
  db.prepare("UPDATE posts SET status = 'rejected', reviewed_at = datetime('now') WHERE id = ?").run(req.params.id);
  res.redirect("/posts/" + req.params.id);
});

// ---------------------------------------------------------------------------
// API: Used by the generation script
// ---------------------------------------------------------------------------

// Get all sites config
app.get("/api/sites", (req, res) => {
  const sites = db.prepare("SELECT * FROM sites").all();
  res.json(sites.map(s => ({
    ...s,
    target_keywords: JSON.parse(s.target_keywords || "[]"),
    auto_approved: !!s.auto_approved,
  })));
});

// Submit a generated post for review or auto-publish
app.post("/api/posts", async (req, res) => {
  const { site_id, post } = req.body;
  const site = db.prepare("SELECT * FROM sites WHERE id = ?").get(site_id);
  if (!site) return res.status(404).json({ error: "Site not found" });

  const id = crypto.randomUUID();
  let status = "pending_review";
  let publishedUrl = "";

  // If site is auto-approved, publish directly
  if (site.auto_approved && site.publish_endpoint) {
    try {
      const payload = {
        title: post.title,
        slug: post.slug,
        metaTitle: post.metaTitle,
        metaDescription: post.metaDescription,
        excerpt: post.excerpt,
        content: post.content,
        category: post.category,
        tags: post.tags,
        date: new Date().toISOString().split("T")[0],
        imagePrompt: post.imagePrompt,
        status: "published",
      };

      const apiResult = await publishToApi(site.publish_endpoint, site.publish_api_key, payload);
      if (apiResult.success) {
        status = "published";
        publishedUrl = apiResult.url || `${site.domain}/blog/${post.slug}`;
      } else {
        status = "pending_review";
        console.error("Auto-publish failed, holding for review:", apiResult.error);
      }
    } catch (err) {
      status = "pending_review";
      console.error("Auto-publish error:", err);
    }
  } else if (site.auto_approved) {
    status = "published";
    publishedUrl = `${site.domain}/blog/${post.slug}`;
  }

  db.prepare(`
    INSERT INTO posts (id, site_id, title, slug, meta_title, meta_description, excerpt, category, tags, content, image_prompt, social_linkedin, social_twitter, status, published_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, site_id, post.title, post.slug, post.metaTitle, post.metaDescription,
    post.excerpt, post.category, JSON.stringify(post.tags || []), post.content,
    post.imagePrompt, post.socialSnippets?.linkedin || "", post.socialSnippets?.twitter || "",
    status, publishedUrl
  );

  res.json({ id, status, publishedUrl });
});

// Check if site needs review
app.get("/api/sites/:id/needs-review", (req, res) => {
  const site = db.prepare("SELECT auto_approved FROM sites WHERE id = ?").get(req.params.id);
  if (!site) return res.status(404).json({ error: "Site not found" });
  res.json({ needsReview: !site.auto_approved });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function syncSitesJson() {
  const sites = db.prepare("SELECT * FROM sites").all();
  const sitesJson = sites.map(s => ({
    id: s.id,
    name: s.name,
    domain: s.domain,
    platform: "nextjs",
    content_mode: "api",
    blog_path: s.blog_path || "/blog",
    publish_endpoint: s.publish_endpoint || "",
    publish_api_key: s.publish_api_key || "",
    niche: s.niche || "",
    tone: s.tone || "professional and modern",
    target_keywords: JSON.parse(s.target_keywords || "[]"),
    post_length: s.post_length || 1500,
    auto_publish: !!s.auto_approved,
    auto_approved: !!s.auto_approved,
    publish_method: "api",
  }));

  // Write to a local file for the dashboard's reference
  const fs = require("fs");
  fs.writeFileSync(path.join(__dirname, "data", "sites.json"), JSON.stringify(sitesJson, null, 2));
}

function publishToApi(endpoint, apiKey, payload) {
  return new Promise((resolve) => {
    const url = new URL(endpoint);
    const client = url.protocol === "https:" ? require("https") : require("http");
    const body = JSON.stringify(payload);
    const headers = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    const req = client.request({
      hostname: url.hostname, port: url.port,
      path: url.pathname + url.search, method: "POST", headers,
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          let postUrl = "";
          try { const p = JSON.parse(data); postUrl = p.url || p.slug || ""; } catch {}
          resolve({ success: true, url: postUrl });
        } else {
          resolve({ success: false, error: `HTTP ${res.statusCode}: ${data.substring(0, 200)}` });
        }
      });
    });
    req.on("error", (err) => resolve({ success: false, error: err.message }));
    req.write(body);
    req.end();
  });
}

function markdownToHtml(md) {
  return md
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/^### (.*$)/gm, "<h3>$1</h3>")
    .replace(/^## (.*$)/gm, "<h2>$1</h2>")
    .replace(/^# (.*$)/gm, "<h1>$1</h1>")
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.*?)\*/g, "<em>$1</em>")
    .replace(/^- (.*$)/gm, "<li>$1</li>")
    .replace(/(<li>.*<\/li>)/s, "<ul>$1</ul>")
    .replace(/^\d+\. (.*$)/gm, "<li>$1</li>")
    .replace(/\n\n/g, "</p><p>")
    .replace(/^(?!<[hulo])(.+)$/gm, "<p>$1</p>")
    .replace(/<p><\/p>/g, "");
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Dashboard running on http://0.0.0.0:${PORT}`);
  syncSitesJson();
});
