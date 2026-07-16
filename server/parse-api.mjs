import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { mkdir, open, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT || process.env.VIDEO_TOOL_PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const BITEMM_HOME_URL = "https://bitemm.com/";
const BITEMM_PARSE_URL = "https://bitemm.com/api/video/parse";
const BITEMM_SECRET = "kL8mN2oP5r";
const PARSE_MAX_ATTEMPTS = 3;
const VIDEO_VALIDATE_TIMEOUT_MS = 15000;
const VIDEO_DOWNLOAD_TIMEOUT_MS = 90000;
const ASSET_FETCH_TIMEOUT_MS = 30000;
const MAX_VIDEO_BYTES = Number(process.env.MAX_VIDEO_BYTES || 500 * 1024 * 1024);
const RATE_LIMIT_PER_HOUR = Number(process.env.RATE_LIMIT_PER_HOUR || 30);
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || "https://video-processing-web.vercel.app,http://localhost:5173,http://127.0.0.1:5173")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

class PublicParseError extends Error {
  constructor(message, technicalError = "") {
    super(message);
    this.technicalError = technicalError;
  }
}

const rateBuckets = new Map();

function originAllowed(origin) {
  if (!ALLOWED_ORIGINS.length || ALLOWED_ORIGINS.includes("*") || ALLOWED_ORIGINS.includes(origin)) return true;
  return ALLOWED_ORIGINS.some((allowed) => {
    if (!allowed.includes("*")) return false;
    const pattern = `^${allowed.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`;
    return new RegExp(pattern).test(origin);
  });
}

function corsOrigin(req) {
  const origin = req.headers.origin || "";
  if (!origin) return ALLOWED_ORIGINS[0] || "*";
  if (originAllowed(origin)) return origin;
  return "";
}

function send(req, res, status, body, headers = {}) {
  const origin = corsOrigin(req);
  res.writeHead(status, {
    ...(origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {}),
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,X-File-Name",
    Connection: "close",
    ...headers,
  });
  res.end(body);
}

function sendJson(req, res, status, body) {
  return send(req, res, status, JSON.stringify(body), { "Content-Type": "application/json; charset=utf-8" });
}

async function readRequestBuffer(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function readJsonBody(req) {
  const buffer = await readRequestBuffer(req);
  if (!buffer.length) return {};
  return JSON.parse(buffer.toString("utf8"));
}

function stripUrlTail(url) {
  return String(url || "")
    .trim()
    .replace(/[，。！？、；：）】》〉」』"'“”‘’]+$/g, "")
    .replace(/[)\]}>,.;!?]+$/g, "");
}

function extractFirstUrl(value) {
  const match = String(value || "").match(/https?:\/\/(?:www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,12}\b(?:[-a-zA-Z0-9()@:%_+.~#?&//=]*)?/);
  return match ? stripUrlTail(match[0]) : "";
}

function detectPlatform(targetUrl) {
  const lower = String(targetUrl || "").toLowerCase();
  if (lower.includes("douyin.com") || lower.includes("iesdouyin.com")) return "douyin";
  if (lower.includes("bilibili.com") || lower.includes("b23.tv")) return "bilibili";
  if (lower.includes("xiaohongshu.com") || lower.includes("xhslink.com")) return "xiaohongshu";
  if (lower.includes("kuaishou.com") || lower.includes("ksurl.cn") || lower.includes("gifshow.com")) return "kuaishou";
  if (lower.includes("tiktok.com")) return "tiktok";
  if (lower.includes("weibo.com")) return "weibo";
  if (lower.includes("youtube.com") || lower.includes("youtu.be")) return "youtube";
  return "other";
}

function safeName(name) {
  return (name || "video").replace(/\.[^/.]+$/, "").replace(/[^\w\u4e00-\u9fa5-]+/g, "_").slice(0, 48) || "video";
}

function sanitizeOutputName(name) {
  return `${safeName(name || "parsed-video")}.mp4`;
}

function compactBitemmInfo(info, fallbackUrl) {
  return {
    title: info?.title || "未命名视频",
    author: info?.author?.name || info?.author || "",
    coverUrl: info?.cover_url || info?.coverUrl || "",
    videoUrl: info?.video_url || info?.videoUrl || "",
    platform: detectPlatform(fallbackUrl),
    sourceUrl: fallbackUrl,
  };
}

function cookieHeaderFrom(response) {
  const getSetCookie = response.headers.getSetCookie?.();
  const cookies = getSetCookie?.length ? getSetCookie : [response.headers.get("set-cookie")].filter(Boolean);
  return cookies.map((item) => String(item).split(";")[0]).filter(Boolean).join("; ");
}

function bitemmHeaders(cookie = "") {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const cipher = createHash("md5").update(`${BITEMM_SECRET}_${timestamp}`).digest("hex");
  return {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    Accept: "application/json, text/plain, */*",
    Referer: BITEMM_HOME_URL,
    Origin: BITEMM_HOME_URL.replace(/\/$/, ""),
    Timestamp: timestamp,
    Cipher: cipher,
    ...(cookie ? { Cookie: cookie } : {}),
  };
}

async function fetchBufferWithAbort(input, init = {}, timeoutMs = 30000, label = "请求") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    const buffer = Buffer.from(await response.arrayBuffer());
    return { response, buffer };
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`${label}超时：${Math.round(timeoutMs / 1000)} 秒`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithAbort(input, init = {}, timeoutMs = 30000, label = "请求") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`${label}超时：${Math.round(timeoutMs / 1000)} 秒`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function parseWithBitemm(targetUrl) {
  const home = await fetchWithAbort(BITEMM_HOME_URL, { headers: bitemmHeaders(), redirect: "follow" }, 30000, "解析服务首页访问");
  const cookie = cookieHeaderFrom(home);
  const endpoint = `${BITEMM_PARSE_URL}?url=${encodeURIComponent(targetUrl)}`;
  const response = await fetchWithAbort(endpoint, { headers: bitemmHeaders(cookie), redirect: "follow" }, 60000, "远程解析");
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.code !== 0) {
    throw new Error(payload?.msg || payload?.message || `bitemm 解析返回 ${response.status}`);
  }
  const info = compactBitemmInfo(payload.data, targetUrl);
  if (!info.videoUrl) throw new Error("解析服务未返回视频地址");
  return info;
}

async function parseLinkWithRetry(targetUrl) {
  const errors = [];
  for (let attempt = 1; attempt <= PARSE_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await parseWithBitemm(targetUrl);
    } catch (error) {
      errors.push(`第 ${attempt} 次：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new PublicParseError("解析失败超过 3 次，已停止该任务。", errors.join("\n"));
}

async function validateDirectVideoUrl(videoUrl, referer) {
  const headers = {
    "User-Agent": "Mozilla/5.0",
    Referer: referer || BITEMM_HOME_URL,
    Range: "bytes=0-2047",
  };
  const { response, buffer: sample } = await fetchBufferWithAbort(videoUrl, { headers, redirect: "follow" }, VIDEO_VALIDATE_TIMEOUT_MS, "视频地址校验");
  if (!response.ok && response.status !== 206) throw new Error(`视频地址校验失败：${response.status}`);
  const contentType = response.headers.get("content-type") || "";
  const looksLikeHtml = sample.toString("utf8", 0, Math.min(sample.length, 80)).trimStart().startsWith("<");
  if (looksLikeHtml || /text\/html/i.test(contentType)) throw new Error("视频地址返回了网页而不是视频文件");
  if (!sample.length) throw new Error("视频地址返回空内容");
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function downloadVideoToTemp(videoUrl, referer, title) {
  await validateDirectVideoUrl(videoUrl, referer);
  const errors = [];
  for (let attempt = 1; attempt <= PARSE_MAX_ATTEMPTS; attempt += 1) {
    const workDir = join(tmpdir(), `videox-parse-${randomUUID()}`);
    const outputPath = join(workDir, "video.bin");
    let file = null;
    try {
      await mkdir(workDir, { recursive: true });
      const response = await fetchWithAbort(videoUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0",
          Referer: referer || BITEMM_HOME_URL,
        },
        redirect: "follow",
      }, VIDEO_DOWNLOAD_TIMEOUT_MS, "视频下载");
      if (!response.ok) throw new Error(`视频下载返回 ${response.status}`);
      const contentType = response.headers.get("content-type") || "video/mp4";
      if (/text\/html/i.test(contentType)) throw new Error("下载结果不是视频文件");
      file = await open(outputPath, "w");
      let total = 0;
      for await (const chunk of response.body) {
        const buffer = Buffer.from(chunk);
        total += buffer.length;
        if (total > MAX_VIDEO_BYTES) throw new Error(`视频超过大小限制：${Math.round(MAX_VIDEO_BYTES / 1024 / 1024)}MB`);
        await file.write(buffer);
      }
      await file.close();
      file = null;
      if (!total) throw new Error("下载结果为空");
      return { outputPath, workDir, contentType, outputName: sanitizeOutputName(title), size: total };
    } catch (error) {
      if (file) await file.close().catch(() => undefined);
      await rm(workDir, { recursive: true, force: true });
      errors.push(`第 ${attempt} 次下载：${error instanceof Error ? error.message : String(error)}`);
      if (attempt < PARSE_MAX_ATTEMPTS) await wait(800 * attempt);
    }
  }
  throw new Error(errors.join("\n"));
}

async function handleParseLink(req, res) {
  const body = await readJsonBody(req);
  const targetUrl = extractFirstUrl(body.url || body.rawText || "");
  if (!targetUrl) throw new Error("请输入需要解析的视频分享链接。");
  const info = await parseLinkWithRetry(targetUrl);
  await validateDirectVideoUrl(info.videoUrl, info.sourceUrl);
  return sendJson(req, res, 200, info);
}

async function handleDownloadParsedVideo(req, res) {
  const body = await readJsonBody(req);
  const targetUrl = extractFirstUrl(body.url || body.rawText || "");
  const parsed = body.videoUrl
    ? { videoUrl: body.videoUrl, title: body.title || "parsed-video", sourceUrl: targetUrl || BITEMM_HOME_URL }
    : await parseLinkWithRetry(targetUrl);
  if (!parsed.videoUrl) throw new Error("没有可下载的视频地址。");
  const result = await downloadVideoToTemp(parsed.videoUrl, parsed.sourceUrl, parsed.title);
  const fileStat = await stat(result.outputPath);
  const origin = corsOrigin(req);
  res.writeHead(200, {
    ...(origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {}),
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,X-File-Name",
    "Access-Control-Expose-Headers": "X-Output-Name",
    Connection: "close",
    "Content-Type": result.contentType,
    "Content-Length": String(fileStat.size),
    "X-Output-Name": encodeURIComponent(result.outputName),
  });
  const stream = createReadStream(result.outputPath);
  stream.pipe(res);
  stream.on("close", () => {
    void rm(result.workDir, { recursive: true, force: true });
  });
  stream.on("error", () => {
    void rm(result.workDir, { recursive: true, force: true });
    res.destroy();
  });
}

async function handleFetchAsset(req, res) {
  const body = await readJsonBody(req);
  const assetUrl = stripUrlTail(body.url || "");
  if (!/^https?:\/\//i.test(assetUrl)) throw new Error("请输入有效的素材地址。");
  const { response, buffer: output } = await fetchBufferWithAbort(assetUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      Referer: body.referer || BITEMM_HOME_URL,
    },
    redirect: "follow",
  }, ASSET_FETCH_TIMEOUT_MS, "素材下载");
  if (!response.ok) throw new Error(`素材下载返回 ${response.status}`);
  if (!output.length) throw new Error("素材下载结果为空");
  return send(req, res, 200, output, { "Content-Type": response.headers.get("content-type") || "application/octet-stream" });
}

function requestIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
}

function enforceRateLimit(req) {
  if (!RATE_LIMIT_PER_HOUR) return;
  const now = Date.now();
  const ip = requestIp(req);
  const bucket = rateBuckets.get(ip);
  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return;
  }
  bucket.count += 1;
  if (bucket.count > RATE_LIMIT_PER_HOUR) {
    const retryMinutes = Math.max(1, Math.ceil((bucket.resetAt - now) / 60000));
    throw new PublicParseError(`解析请求过于频繁，请约 ${retryMinutes} 分钟后再试。`);
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of rateBuckets.entries()) {
    if (bucket.resetAt <= now) rateBuckets.delete(ip);
  }
}, 10 * 60 * 1000).unref();

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(req, res, 204, "");
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  try {
    if (!corsOrigin(req)) return sendJson(req, res, 403, { error: "当前来源不允许访问解析服务。" });
    if (url.pathname === "/api/health") {
      return sendJson(req, res, 200, {
        ok: true,
        service: "videox-parse-api",
        maxVideoBytes: MAX_VIDEO_BYTES,
        rateLimitPerHour: RATE_LIMIT_PER_HOUR,
      });
    }
    if (req.method === "POST" && url.pathname === "/api/parse-link") {
      enforceRateLimit(req);
      return await handleParseLink(req, res);
    }
    if (req.method === "POST" && url.pathname === "/api/download-parsed-video") {
      enforceRateLimit(req);
      return await handleDownloadParsedVideo(req, res);
    }
    if (req.method === "POST" && url.pathname === "/api/fetch-asset") return await handleFetchAsset(req, res);
    return sendJson(req, res, 404, { error: "Not found" });
  } catch (error) {
    const status = error instanceof PublicParseError && error.message.includes("频繁") ? 429 : 500;
    return sendJson(req, res, status, {
      error: error instanceof Error ? error.message : "未知错误",
      technicalError: error instanceof PublicParseError ? error.technicalError : "",
    });
  }
});

server.on("error", (error) => {
  console.error(`VideoX parse API failed to listen on ${HOST}:${PORT}:`, error);
});

server.listen(PORT, HOST, () => {
  console.log(`VideoX parse API listening on http://${HOST}:${PORT}`);
  console.log(`Allowed origins: ${ALLOWED_ORIGINS.join(", ") || "*"}`);
  console.log(`Max video size: ${Math.round(MAX_VIDEO_BYTES / 1024 / 1024)}MB`);
});
