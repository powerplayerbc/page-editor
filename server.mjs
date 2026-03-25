import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sitesDir = path.join(__dirname, "sites");
const publicDir = path.join(__dirname, "public");
const PORT = process.env.PORT || 3000;

const MIME_TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

/* ── Helpers ── */

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function jsonResponse(res, status, data) {
  cors(res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function safePath(base, ...segments) {
  const resolved = path.resolve(path.join(base, ...segments));
  if (!resolved.startsWith(path.resolve(base))) return null;
  return resolved;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/* ── Route handlers ── */

function listSites(req, res) {
  if (!fs.existsSync(sitesDir)) return jsonResponse(res, 200, []);
  const entries = fs.readdirSync(sitesDir, { withFileTypes: true });
  const sites = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => {
      const siteDir = path.join(sitesDir, e.name);
      const pages = fs.readdirSync(siteDir).filter((f) => f.endsWith(".html")).length;
      const hasAssets = fs.existsSync(path.join(siteDir, "brand_assets"));
      return { name: e.name, pages, hasAssets };
    });
  jsonResponse(res, 200, sites);
}

function listPages(req, res, site) {
  const siteDir = safePath(sitesDir, site);
  if (!siteDir || !fs.existsSync(siteDir)) return jsonResponse(res, 404, { error: "Site not found" });
  const files = fs.readdirSync(siteDir).filter((f) => f.endsWith(".html"));
  const pages = files.map((f) => {
    const stat = fs.statSync(path.join(siteDir, f));
    return { name: f, size: stat.size, modified: stat.mtime.toISOString() };
  });
  jsonResponse(res, 200, pages);
}

function readPage(req, res, site, page) {
  const filePath = safePath(sitesDir, site, page);
  if (!filePath || !filePath.endsWith(".html")) return jsonResponse(res, 400, { error: "Invalid page path" });
  if (!fs.existsSync(filePath)) return jsonResponse(res, 404, { error: "Page not found" });
  const content = fs.readFileSync(filePath, "utf8");
  jsonResponse(res, 200, { name: page, content });
}

async function writePage(req, res, site, page) {
  const filePath = safePath(sitesDir, site, page);
  if (!filePath || !filePath.endsWith(".html")) return jsonResponse(res, 400, { error: "Invalid page path" });
  const body = await readBody(req);
  let content;
  try {
    const parsed = JSON.parse(body);
    content = parsed.content;
  } catch {
    return jsonResponse(res, 400, { error: "Invalid JSON body" });
  }
  if (!content) return jsonResponse(res, 400, { error: "Missing content field" });

  // Backup before overwriting
  if (fs.existsSync(filePath)) {
    const backupDir = path.join(path.dirname(filePath), ".backups");
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    fs.copyFileSync(filePath, path.join(backupDir, `${page}.${ts}.bak`));
  }

  fs.writeFileSync(filePath, content, "utf8");
  jsonResponse(res, 200, { ok: true, saved: page });
}

async function createPage(req, res, site) {
  const body = await readBody(req);
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    return jsonResponse(res, 400, { error: "Invalid JSON body" });
  }
  if (!data.name || !data.content) return jsonResponse(res, 400, { error: "Missing name or content" });
  if (!data.name.endsWith(".html")) data.name += ".html";

  const siteDir = safePath(sitesDir, site);
  if (!siteDir) return jsonResponse(res, 400, { error: "Invalid site" });
  if (!fs.existsSync(siteDir)) fs.mkdirSync(siteDir, { recursive: true });

  const filePath = path.join(siteDir, data.name);
  if (fs.existsSync(filePath)) return jsonResponse(res, 409, { error: "Page already exists" });

  fs.writeFileSync(filePath, data.content, "utf8");
  jsonResponse(res, 201, { ok: true, created: data.name });
}

function listAssets(req, res, site) {
  const assetsDir = safePath(sitesDir, site, "brand_assets");
  if (!assetsDir || !fs.existsSync(assetsDir)) return jsonResponse(res, 200, []);
  const results = [];
  function walk(dir, prefix) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), rel);
      } else {
        const ext = path.extname(entry.name).toLowerCase();
        if ([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"].includes(ext)) {
          results.push({ name: entry.name, path: `brand_assets/${rel}`, type: MIME_TYPES[ext] || "image/*" });
        }
      }
    }
  }
  walk(assetsDir, "");
  jsonResponse(res, 200, results);
}

/* ── Static file serving ── */

function serveFile(res, filePath) {
  if (!fs.existsSync(filePath)) { res.writeHead(404); return res.end("Not found"); }
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME_TYPES[ext] || "application/octet-stream";
  cors(res);
  res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-cache" });
  res.end(fs.readFileSync(filePath));
}

/* ── Router ── */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const urlPath = url.pathname;
  const method = req.method;

  // CORS preflight
  if (method === "OPTIONS") {
    cors(res);
    res.writeHead(204);
    return res.end();
  }

  try {
    // ── API routes ──
    const apiMatch = urlPath.match(/^\/api\/sites\/([^/]+)(?:\/(pages)(?:\/([^/]+))?|\/(assets))?$/);

    if (urlPath === "/api/sites" && method === "GET") return listSites(req, res);

    if (apiMatch) {
      const site = decodeURIComponent(apiMatch[1]);
      const isPages = apiMatch[2] === "pages";
      const page = apiMatch[3] ? decodeURIComponent(apiMatch[3]) : null;
      const isAssets = apiMatch[4] === "assets";

      if (isAssets && method === "GET") return listAssets(req, res, site);
      if (isPages && !page && method === "GET") return listPages(req, res, site);
      if (isPages && !page && method === "POST") return createPage(req, res, site);
      if (isPages && page && method === "GET") return readPage(req, res, site, page);
      if (isPages && page && method === "PUT") return writePage(req, res, site, page);
    }

    // ── Serve site files (for canvas iframe) ──
    if (urlPath.startsWith("/sites/")) {
      const relPath = urlPath.slice(7);
      const filePath = safePath(sitesDir, relPath);
      if (filePath) return serveFile(res, filePath);
      res.writeHead(404); return res.end("Not found");
    }

    // ── Serve public UI ──
    let filePath;
    if (urlPath === "/" || urlPath === "/page-builder") {
      filePath = path.join(publicDir, "index.html");
    } else {
      filePath = safePath(publicDir, urlPath);
    }
    if (filePath) return serveFile(res, filePath);

    res.writeHead(404);
    res.end("Not found");
  } catch (err) {
    console.error("Server error:", err);
    jsonResponse(res, 500, { error: "Internal server error" });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Page Editor running at http://0.0.0.0:${PORT}`);
  console.log(`Sites directory: ${sitesDir}`);
});
