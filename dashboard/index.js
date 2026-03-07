const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

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

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

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
  <main>${body}</main>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function publishToApi(endpoint, apiKey, payload) {
  return new Promise((resolve) => {
    const url = new URL(endpoint);
    const client = url.protocol === "https:" ? require("https") : require("http");
    const body = JSON.stringify(payload);
    const headers = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) };
    if (apiKey) headers["Authorization"] = "Bearer " + apiKey;

    const req = client.request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: "POST", headers },
      (res) => {
        let data = "";
        res.on("data", (c) => data += c);
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            let postUrl = "";
            try { const p = JSON.parse(data); postUrl = p.url || p.slug || ""; } catch {}
            resolve({ success: true, url: postUrl });
          } else {
            resolve({ success: false, error: "HTTP " + res.statusCode + ": " + data.substring(0, 200) });
          }
        });
      }
    );
    req.on("error", (err) => resolve({ success: false, error: err.message }));
    req.write(body);
    req.end();
  });
}

function markdownToHtml(md) {
  if (!md) return "";
  return md
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/^### (.*$)/gm, "<h3>$1</h3>")
    .replace(/^## (.*$)/gm, "<h2>$1</h2>")
    .replace(/^# (.*$)/gm, "<h1>$1</h1>")
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.*?)\*/g, "<em>$1</em>")
    .replace(/^- (.*$)/gm, "<li>$1</li>")
    .replace(/^\d+\. (.*$)/gm, "<li>$1</li>")
    .replace(/\n\n/g, "</p><p>")
    .replace(/^(?!<[hulo])(.+)$/gm, "<p>$1</p>")
    .replace(/<p><\/p>/g, "");
}

function esc(s) { return (s || "").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

// ---------------------------------------------------------------------------
// Routes: Dashboard
// ---------------------------------------------------------------------------
app.get("/", (req, res) => {
  const sites = getSites();
  const posts = getPosts();
  const pendingPosts = posts.filter(p => p.status === "pending_review");
  const publishedCount = posts.filter(p => p.status === "published").length;

  const pendingHtml = pendingPosts.length > 0
    ? pendingPosts.map(p => {
        const site = sites.find(s => s.id === p.site_id);
        return '<div class="post-card pending_review">' +
          '<div class="post-header"><span class="badge badge-pending">Pending Review</span>' +
          '<span class="site-tag">' + esc(site ? site.name : "Unknown") + '</span></div>' +
          '<h3>' + esc(p.title) + '</h3>' +
          '<p class="excerpt">' + esc(p.excerpt) + '</p>' +
          '<div class="post-meta"><span>' + esc(p.category) + '</span><span>' + p.generated_at + '</span></div>' +
          '<div class="post-actions"><a href="/posts/' + p.id + '" class="btn btn-primary">Review</a></div>' +
          '</div>';
      }).join("")
    : '<p class="empty-state">No posts pending review. All clear!</p>';

  res.send(render("Dashboard", `
    <div class="dashboard">
      <h1>Dashboard</h1>
      <div class="stats">
        <div class="stat-card"><div class="stat-number">${sites.length}</div><div class="stat-label">Sites</div></div>
        <div class="stat-card"><div class="stat-number">${pendingPosts.length}</div><div class="stat-label">Pending Review</div></div>
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
        return '<div class="site-card">' +
          '<div class="site-header"><h3>' + esc(s.name) + '</h3>' +
          (s.auto_approved ? '<span class="badge badge-auto">Auto-publish</span>' : '<span class="badge badge-review">Review first</span>') +
          '</div>' +
          '<p class="domain"><a href="' + esc(s.domain) + '" target="_blank">' + esc(s.domain) + '</a></p>' +
          '<p class="niche">' + esc(s.niche) + '</p>' +
          '<div class="site-meta"><span>' + count + ' post(s)</span><span>Tone: ' + esc(s.tone) + '</span></div>' +
          '<div class="site-actions">' +
          '<a href="/sites/' + s.id + '" class="btn btn-secondary">Edit</a>' +
          '<form method="POST" action="/sites/' + s.id + '/delete" style="display:inline" onsubmit="return confirm(\'Delete this site?\')"><button type="submit" class="btn btn-danger">Delete</button></form>' +
          '</div></div>';
      }).join("")
    : '<p class="empty-state">No sites configured yet. <a href="/sites/add">Add your first site</a></p>';

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
      <form method="POST" action="/sites" class="site-form">
        <div class="form-group"><label>Website Name *</label><input type="text" name="name" required placeholder="e.g. Synthera"></div>
        <div class="form-group"><label>Domain *</label><input type="url" name="domain" required placeholder="https://www.example.com"></div>
        <div class="form-group"><label>Blog Path</label><input type="text" name="blog_path" value="/blog" placeholder="/blog"></div>
        <div class="form-group"><label>Blog API Endpoint</label><input type="url" name="publish_endpoint" placeholder="https://www.example.com/api/blog/create"><small>The API endpoint where blog posts will be published</small></div>
        <div class="form-group"><label>Blog API Key</label><input type="text" name="publish_api_key" placeholder="Your API key for publishing"></div>
        <div class="form-group"><label>Niche / Topics *</label><input type="text" name="niche" required placeholder="e.g. AI automation, SaaS platforms"></div>
        <div class="form-group"><label>Writing Tone</label>
          <select name="tone">
            <option value="professional and modern">Professional &amp; Modern</option>
            <option value="informative and engaging">Informative &amp; Engaging</option>
            <option value="casual and friendly">Casual &amp; Friendly</option>
            <option value="technical and authoritative">Technical &amp; Authoritative</option>
            <option value="conversational">Conversational</option>
          </select>
        </div>
        <div class="form-group"><label>Target Keywords (comma-separated)</label><input type="text" name="target_keywords" placeholder="AI automation, voice agents, customer support"></div>
        <div class="form-group"><label>Post Length (words)</label><input type="number" name="post_length" value="1500" min="800" max="3000"></div>
        <button type="submit" class="btn btn-primary btn-large">Add Website</button>
      </form>
    </div>
  `));
});

app.post("/sites", (req, res) => {
  const sites = getSites();
  const keywords = req.body.target_keywords ? req.body.target_keywords.split(",").map(k => k.trim()).filter(Boolean) : [];
  sites.push({
    id: crypto.randomUUID(),
    name: req.body.name,
    domain: req.body.domain,
    blog_path: req.body.blog_path || "/blog",
    publish_endpoint: req.body.publish_endpoint || "",
    publish_api_key: req.body.publish_api_key || "",
    niche: req.body.niche,
    tone: req.body.tone || "professional and modern",
    target_keywords: keywords,
    post_length: parseInt(req.body.post_length) || 1500,
    auto_approved: false,
    created_at: new Date().toISOString(),
  });
  saveSites(sites);
  res.redirect("/sites");
});

app.get("/sites/:id", (req, res) => {
  const site = getSites().find(s => s.id === req.params.id);
  if (!site) return res.status(404).send(render("Not Found", "<h1>Site not found</h1>"));
  const kw = (site.target_keywords || []).join(", ");
  const toneOpts = ["professional and modern","informative and engaging","casual and friendly","technical and authoritative","conversational"];

  res.send(render("Edit " + site.name, `
    <div class="form-page">
      <h1>Edit: ${esc(site.name)}</h1>
      <form method="POST" action="/sites/${site.id}/update" class="site-form">
        <div class="form-group"><label>Website Name *</label><input type="text" name="name" required value="${esc(site.name)}"></div>
        <div class="form-group"><label>Domain *</label><input type="url" name="domain" required value="${esc(site.domain)}"></div>
        <div class="form-group"><label>Blog Path</label><input type="text" name="blog_path" value="${esc(site.blog_path || "/blog")}"></div>
        <div class="form-group"><label>Blog API Endpoint</label><input type="url" name="publish_endpoint" value="${esc(site.publish_endpoint)}"></div>
        <div class="form-group"><label>Blog API Key</label><input type="text" name="publish_api_key" value="${esc(site.publish_api_key)}"></div>
        <div class="form-group"><label>Niche / Topics *</label><input type="text" name="niche" required value="${esc(site.niche)}"></div>
        <div class="form-group"><label>Writing Tone</label>
          <select name="tone">${toneOpts.map(t => '<option value="' + t + '"' + (site.tone === t ? " selected" : "") + '>' + t + '</option>').join("")}</select>
        </div>
        <div class="form-group"><label>Target Keywords (comma-separated)</label><input type="text" name="target_keywords" value="${esc(kw)}"></div>
        <div class="form-group"><label>Post Length (words)</label><input type="number" name="post_length" value="${site.post_length}" min="800" max="3000"></div>
        <button type="submit" class="btn btn-primary btn-large">Save Changes</button>
      </form>
    </div>
  `));
});

app.post("/sites/:id/update", (req, res) => {
  const sites = getSites();
  const idx = sites.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).send("Not found");
  const keywords = req.body.target_keywords ? req.body.target_keywords.split(",").map(k => k.trim()).filter(Boolean) : [];
  sites[idx] = { ...sites[idx], name: req.body.name, domain: req.body.domain, blog_path: req.body.blog_path || "/blog", publish_endpoint: req.body.publish_endpoint || "", publish_api_key: req.body.publish_api_key || "", niche: req.body.niche, tone: req.body.tone, target_keywords: keywords, post_length: parseInt(req.body.post_length) || 1500 };
  saveSites(sites);
  res.redirect("/sites");
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
          '<div class="post-header"><span class="badge ' + bc + '">' + (p.status || "").replace("_", " ") + '</span>' +
          '<span class="site-tag">' + esc(site ? site.name : "Unknown") + '</span></div>' +
          '<h3>' + esc(p.title) + '</h3>' +
          '<p class="excerpt">' + esc(p.excerpt) + '</p>' +
          '<div class="post-meta"><span>' + esc(p.category) + '</span><span>' + (p.generated_at || "") + '</span>' +
          (p.published_url ? '<a href="' + esc(p.published_url) + '" target="_blank">View live</a>' : "") +
          '</div><div class="post-actions"><a href="/posts/' + p.id + '" class="btn btn-secondary">View</a></div></div>';
      }).join("")
    : '<p class="empty-state">No posts yet. Add a site and trigger a generation run.</p>';

  const tabs = [["all","All"],["pending_review","Pending"],["published","Published"],["rejected","Rejected"]];
  const tabsHtml = tabs.map(([v,l]) => '<a href="/posts?status=' + v + '" class="tab ' + (filter === v ? "active" : "") + '">' + l + '</a>').join("");

  res.send(render("Posts", `
    <div class="posts-page">
      <div class="page-header"><h1>All Posts</h1><div class="filter-tabs">${tabsHtml}</div></div>
      <div class="post-list">${postRows}</div>
    </div>
  `));
});

app.get("/posts/:id", (req, res) => {
  const sites = getSites();
  const post = getPosts().find(p => p.id === req.params.id);
  if (!post) return res.status(404).send(render("Not Found", "<h1>Post not found</h1>"));
  const site = sites.find(s => s.id === post.site_id);
  const tags = (post.tags || []).join(", ");
  const isPending = post.status === "pending_review";
  const bc = post.status === "published" ? "badge-published" : post.status === "pending_review" ? "badge-pending" : "badge-rejected";

  res.send(render(post.title, `
    <div class="post-detail">
      <div class="post-detail-header">
        <a href="/posts" class="back-link">Back to posts</a>
        <div class="post-detail-meta">
          <span class="badge ${bc}">${(post.status || "").replace("_", " ")}</span>
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
      ${post.published_url ? '<p class="published-link">Published: <a href="' + esc(post.published_url) + '" target="_blank">' + esc(post.published_url) + '</a></p>' : ""}
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
    try {
      const result = await publishToApi(site.publish_endpoint, site.publish_api_key, payload);
      if (result.success && result.url) publishedUrl = result.url;
    } catch (err) { console.error("Publish error:", err); }
  }

  posts[idx].status = "published";
  posts[idx].published_url = publishedUrl;
  posts[idx].published_at = new Date().toISOString();
  posts[idx].reviewed_at = new Date().toISOString();
  savePosts(posts);

  // Auto-approve site for future posts
  if (site) {
    const siteIdx = sites.findIndex(s => s.id === site.id);
    if (siteIdx !== -1) { sites[siteIdx].auto_approved = true; saveSites(sites); }
  }

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
  res.json(getSites());
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
    try {
      const result = await publishToApi(site.publish_endpoint, site.publish_api_key, payload);
      if (result.success) { status = "published"; publishedUrl = result.url || site.domain + "/blog/" + post.slug; }
    } catch (err) { console.error("Auto-publish failed:", err); }
  } else if (site.auto_approved) {
    status = "published";
    publishedUrl = site.domain + "/blog/" + post.slug;
  }

  const posts = getPosts();
  posts.push({
    id, site_id,
    title: post.title, slug: post.slug,
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

app.get("/api/sites/:id/needs-review", (req, res) => {
  const site = getSites().find(s => s.id === req.params.id);
  if (!site) return res.status(404).json({ error: "Site not found" });
  res.json({ needsReview: !site.auto_approved });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, "0.0.0.0", () => {
  console.log("Dashboard running on http://0.0.0.0:" + PORT);
});
