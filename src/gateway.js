import express from "express";
import path from "node:path";
import { config } from "./config.js";
import {
  loadSession,
  saveSession,
  clearSession,
  getSessionStatus,
  maskSession,
  normalizeSessionId,
  listAccounts,
  setActiveAccount,
  removeAccount,
  upsertAccount,
  pickAvailableAccount,
  markAccountRateLimited,
  buildCookieHeader,
  sweepExpiredCooldowns,
  clearAccountCooldown,
  clearAllCooldowns,
} from "./session-store.js";
import { loginAndCaptureSession } from "./login-browser.js";
import { generateVideo } from "./video-client.js";
import { enterpriseVideoFile, enterpriseVideoSource } from "./enterprise-video-client.js";
import { getVideoReadiness } from './video-readiness.js';
import { followsVideoTask } from '../public/video-task-state.js';
import { storeUploadedFrame, readUploadedFrame } from './video-frame-upload.js';
import { listCanvases, createCanvas, getCanvas, saveCanvas, deleteCanvas } from './canvas-store.js';
import { canvasSceneSummary, composeVideoScene, reserveVideoScene, releaseRejectedScene } from './canvas-scenes.js';
import { saveGeneratedImages, readMediaImage, listMediaImages } from './image-save.js';
import { generateEnterpriseImage } from './enterprise-image-client.js';
import { startImageJob, getImageJob, resumeImageJobs, cancelImageJob, imageJobReferencePolicy } from './image-jobs.js';
import { generateCompatibleImage, imageCapabilities, saveImageProviderSettings } from './image-providers.js';
import { randomBytes } from 'node:crypto';
import { videoSubmissionPolicy } from './video-submission.js';
import { videoAttachmentUploadPolicy } from './video-attachment-upload.js';
import { startEnterpriseVideoJob, getEnterpriseVideoJob, recoverEnterpriseVideoJob, listEnterpriseVideoJobs,
  refreshEnterpriseVideoJob, cancelEnterpriseVideoJob, jobEvents } from "./enterprise-video-jobs.js";
import { generateImage, RateLimitError } from "./image-client.js";
import {
  probeCdp,
  captureCdpScreenshot,
  isCdpConfigured,
} from "./cdp-preview.js";
import { isCdpEnabled } from "./cdp-samantha.js";
import { chromium } from "playwright";
import { logger, readLogTail } from "./logger.js";

let loginInFlight = null;

function extractBearer(req) {
  const h = req.headers.authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : "";
}

/** 从 OpenAI / Toonflow 请求体里抽出参考图（base64 或 URL） */
function collectRefImages(body = {}) {
  const out = [];
  const push = (v) => {
    if (!v) return;
    if (typeof v === "string" && v.trim()) {
      out.push(v.trim());
      return;
    }
    if (typeof v === "object") {
      const s =
        v.base64 ||
        v.url ||
        v.image_url?.url ||
        v.b64_json ||
        (typeof v.image === "string" ? v.image : "");
      if (s) {
        if (v.b64_json && !String(s).startsWith("data:")) {
          out.push(`data:image/png;base64,${s}`);
        } else {
          out.push(String(s));
        }
      }
    }
  };

  // 优先 images 数组；image 单字段仅在无数组时使用（避免与 images[0] 重复计入）
  if (Array.isArray(body.images) && body.images.length) {
    body.images.forEach(push);
  } else {
    push(body.image);
  }
  if (Array.isArray(body.reference_images)) body.reference_images.forEach(push);
  if (Array.isArray(body.referenceImages)) body.referenceImages.forEach(push);
  if (Array.isArray(body.referenceList)) body.referenceList.forEach(push);
  // OpenAI vision 风格
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (item?.image_url) push(item.image_url);
      if (item?.image) push(item.image);
    }
  }
  // 去重保序：不能只用前缀——JPEG data URL 常以相同 /9j/4AAQ... 开头，会把不同图误判成一张
  const seen = new Set();
  return out.filter((u) => {
    const k = `${u.length}:${u.slice(0, 48)}:${u.slice(-64)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function requireLocalKey(req, res, next) {
  const token = extractBearer(req);
  if (!token || token !== config.localApiKey) {
    return res.status(401).json({
      error: {
        message: "无效的 LOCAL_API_KEY。请使用 Authorization: Bearer <LOCAL_API_KEY>",
        type: "auth_error",
      },
    });
  }
  return next();
}

// Read-only media cookie for <img>/<video> on the local pages. It is not the
// API key, changes on every gateway start and only opens media GET routes.
const mediaToken = randomBytes(32).toString('hex');
function requireMediaAccess(req, res, next) {
  const cookie = /(?:^|;\s*)orbit_media=([0-9a-f]{64})(?:;|$)/.exec(req.get('cookie') || '')?.[1];
  if (cookie === mediaToken) return next();
  return requireLocalKey(req, res, next);
}

function enterpriseVideoResponse(job, prompt = "") {
  const videos = (job.videos || []).map(video => ({
    ...video, video_url: `http://127.0.0.1:${config.port}${video.url}`,
  }));
  return {
    created: Math.floor(new Date(job.created_at).getTime() / 1000),
    provider: 'doubao-desktop', task_id: job.id, status: job.status, phase: job.phase ?? null,
    conversation_id: job.conversation_id, run_id: job.run_id,
    prompt: job.prompt, duration: job.duration, ratio: job.ratio,
    mode: job.mode, frames: job.frames, warnings: job.warnings,
    created_at: job.created_at, updated_at: job.updated_at,
    requested_model: job.requested_model, model_verification: job.model_verification,
    cancellation:job.cancellation || null,
    failure_history: job.failure_history || [], recovery_history: job.recovery_history || [],
    submission_diagnostic: job.submission_diagnostic || null, submission_receipt: job.submission_receipt || null,
    error: job.error || null, next_action: job.next_action || null,
    last_checked_at: job.last_checked_at || null, phase_started_at: job.phase_started_at || null,
    timings_ms: job.timings_ms || {}, observed_phases: job.observed_phases || [], delivery: job.delivery || null,
    data: videos.map(video => ({ url: video.video_url, revised_prompt: prompt || undefined })),
    videos, pending: job.pending, message: job.message,
    task_url: `/v1/videos/tasks/${job.id}`,
  };
}

async function getUpstreamSessionId(req) {
  const bearer = extractBearer(req);
  if (bearer && bearer !== config.localApiKey && bearer.length > 20) {
    return normalizeSessionId(bearer);
  }
  const session = await loadSession();
  return session?.sessionId || null;
}

async function proxyJson(req, res, upstreamPath) {
  const sessionId = await getUpstreamSessionId(req);
  if (!sessionId) {
    return res.status(401).json({
      error: {
        message: "尚未登录豆包。请打开管理页点击「登录豆包」，或 POST /admin/login",
        type: "session_missing",
      },
    });
  }

  const url = `${config.upstreamUrl}${upstreamPath}`;
  let upstream;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sessionId}`,
      },
      body: JSON.stringify(req.body ?? {}),
    });
  } catch (err) {
    return res.status(502).json({
      error: {
        message: `无法连接上游 doubao-free-api（${config.upstreamUrl}）。请用 npm start 同时启动上游，或另开终端 npm run upstream`,
        detail: String(err.message || err),
        type: "upstream_unreachable",
      },
    });
  }

  const text = await upstream.text();
  const contentType = upstream.headers.get("content-type") || "application/json";
  res.status(upstream.status).type(contentType);

  if (contentType.includes("application/json")) {
    try {
      return res.send(JSON.parse(text));
    } catch {
      return res.send(text);
    }
  }
  return res.send(text);
}

/** 从调试浏览器同步 Cookie 到本地账号池（CDP 登录后用） */
async function syncCookiesFromCdp() {
  const cdpUrl = (process.env.DOUBAO_CDP_URL || "http://127.0.0.1:9222").replace(
    /\/$/,
    ""
  );
  logger.info("cdp sync cookies start", { cdpUrl });
  const browser = await chromium.connectOverCDP(cdpUrl);
  const context = browser.contexts()[0];
  if (!context) throw new Error("CDP 无浏览器上下文");
  const cookies = await context.cookies([
    "https://www.doubao.com",
    "https://doubao.com",
  ]);
  const session = cookies.find((c) => c.name === "sessionid" && c.value);
  if (!session?.value) {
    throw new Error("调试浏览器尚未登录豆包（未检测到 sessionid）");
  }
  const cookieHeader = buildCookieHeader(cookies);
  const saved = await upsertAccount(session.value, {
    source: "cdp",
    cookieHeader,
    label: `CDP ${new Date().toLocaleString()}`,
    setActive: true,
  });
  await clearAccountCooldown(saved.id).catch(() => {});
  logger.info("cdp sync cookies ok", {
    id: saved.id,
    masked: maskSession(saved.sessionId),
    cookieCount: cookies.length,
  });
  return saved;
}

async function runImageWithFailover(body) {
  const tried = [];
  let lastErr = null;
  const refImages = collectRefImages(body);

  // CDP 模式：优先用调试浏览器 Cookie，并忽略本地冷却
  if (isCdpEnabled()) {
    try {
      const synced = await syncCookiesFromCdp();
      logger.info("image via cdp", {
        prompt: String(body.prompt || "").slice(0, 80),
        model: body.model,
        ratio: body.ratio,
        refs: refImages.length,
      });
      const t0 = Date.now();
      const result = await generateImage({
        cookieHeader: synced.cookieHeader,
        prompt: body.prompt,
        model: body.model || "Seedream 4.5",
        ratio: body.ratio || "1:1",
        style: body.style || "默认",
        images: refImages,
        useCdp: true,
      });
      const uniq = [];
      const seenKey = new Set();
      for (const u of result.images) {
        const clean = String(u).replace(/\\u0026/g, "&");
        const k = clean.split("~")[0];
        if (seenKey.has(k)) continue;
        seenKey.add(k);
        uniq.push(clean);
      }
      result.images = uniq;
      logger.info("image ok (cdp)", {
        images: uniq.length,
        refs: refImages.length,
        ms: Date.now() - t0,
        account: maskSession(synced.sessionId),
      });
      return { result, account: synced };
    } catch (err) {
      lastErr = err;
      logger.warn("image cdp failed", { message: String(err.message || err) });
    }
  }

  const storeSnapshot = await listAccounts();
  // CDP 开启时强制清冷却再试
  if (isCdpEnabled()) {
    await clearAllCooldowns();
  }

  for (let i = 0; i < 8; i++) {
    const account = await pickAvailableAccount();
    if (!account) {
      const hasAny = storeSnapshot.length > 0 || tried.length > 0;
      throw Object.assign(
        new Error(
          lastErr?.message ||
            (hasAny
              ? `所有账号均限流/冷却中（已试 ${tried.length || storeSnapshot.length} 个）。CDP 模式下请保持调试浏览器登录；或点「清除全部冷却」。`
              : "尚未登录豆包。请先打开调试浏览器登录，或管理页登录。")
        ),
        {
          type: hasAny || lastErr ? "rate_limited" : "session_missing",
          needSwitchAccount: true,
          tried,
        }
      );
    }
    if (tried.includes(account.id)) {
      throw Object.assign(
        lastErr || new Error("可用账号已全部试过且仍失败。"),
        { type: "rate_limited", needSwitchAccount: true, tried }
      );
    }
    tried.push(account.id);

    const cookieHeader =
      account.cookieHeader ||
      buildCookieHeader(account.sessionId) ||
      `sessionid=${account.sessionId}; sessionid_ss=${account.sessionId}`;

    try {
      const result = await generateImage({
        cookieHeader,
        prompt: body.prompt,
        model: body.model || "Seedream 4.5",
        ratio: body.ratio || "1:1",
        style: body.style || "默认",
        images: refImages,
        useCdp: isCdpEnabled(),
      });
      const uniq = [];
      const seenKey = new Set();
      for (const u of result.images) {
        const clean = String(u).replace(/\\u0026/g, "&");
        const k = clean.split("~")[0];
        if (seenKey.has(k)) continue;
        seenKey.add(k);
        uniq.push(clean);
      }
      result.images = uniq;
      return { result, account };
    } catch (err) {
      lastErr = err;
      if (err instanceof RateLimitError || err?.type === "rate_limited") {
        // CDP 模式下不锁账号，避免误拦
        if (!isCdpEnabled()) {
          const sw = await markAccountRateLimited(account.id, err.message, 60 * 1000);
          if (sw.switched) continue;
        }
        continue;
      }
      throw err;
    }
  }

  throw Object.assign(lastErr || new Error("生图失败"), {
    type: lastErr?.type || "rate_limited",
    needSwitchAccount: true,
    tried,
  });
}

function startLogin(opts = {}) {
  if (loginInFlight) {
    return Promise.resolve({ ok: false, status: 409, message: "已有登录流程进行中" });
  }
  const logs = [];
  loginInFlight = loginAndCaptureSession({
    clearProfile: Boolean(opts.switchAccount),
    label: opts.label,
    onStatus: (msg) => logs.push(msg),
  })
    .then((saved) => ({
      ok: true,
      status: 200,
      id: saved.id,
      masked: maskSession(saved.sessionId),
      updatedAt: saved.updatedAt,
      logs,
    }))
    .catch((err) => ({
      ok: false,
      status: 500,
      message: String(err.message || err),
      logs,
    }))
    .finally(() => {
      loginInFlight = null;
    });
  return loginInFlight;
}

export function createApp() {
  const app = express();
  app.use(express.json({ limit: "80mb" }));

  app.use((req, res, next) => {
    if (req.path.startsWith("/admin/logs")) return next();
    if (req.path.startsWith("/admin/ref-preview")) return next();
    const quiet =
      req.path === "/admin/status" ||
      req.path === "/admin/accounts" ||
      req.path === "/admin/accounts/check" ||
      req.path === "/admin/cdp/status" ||
      req.path === "/admin/cdp/screenshot" ||
      req.path === "/health";
    const start = Date.now();
    res.on("finish", () => {
      if (quiet && res.statusCode < 400) return;
      logger.info("http", {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Date.now() - start,
      });
    });
    next();
  });

  app.use(express.static(path.join(config.root, "public"), { setHeaders(res, file) {
    if (/\.(?:html|js)$/.test(file)) res.setHeader('Cache-Control', 'no-store');
  } }));

  // Bootstrap the local page only; reject external origins and DNS rebinding.
  app.post('/api/local-access', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const port = req.socket.localPort;
    const host = req.get('host');
    const localHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    const peer = req.socket.remoteAddress;
    const localPeer = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
    const fetchSite = req.get('sec-fetch-site');
    if (!localPeer || !localHosts.has(host) || req.get('origin') !== `http://${host}` ||
        !req.is('application/json') || fetchSite && fetchSite !== 'same-origin') {
      return res.status(403).json({ error: { type: 'local_page_only', message: '仅本机网关页面可自动连接。' } });
    }
    // Paths let the settings page build agent instructions for this machine.
    res.cookie('orbit_media', mediaToken, { httpOnly: true, sameSite: 'strict', path: '/v1' });
    return res.json({ api_key: config.localApiKey, project_dir: config.root, media_dir: config.mediaDir });
  });

  // An open page may outlive a gateway restart. Renew its media-only cookie
  // using the existing API credential before native range-based playback.
  app.post('/api/media-access', requireLocalKey, (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.cookie('orbit_media', mediaToken, { httpOnly: true, sameSite: 'strict', path: '/v1' });
    return res.json({ ok: true });
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "doubao-relay", pid: process.pid,
      started_at: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      image_job_reference_policy: imageJobReferencePolicy, video_submission_policy: videoSubmissionPolicy,
      video_attachment_upload_policy: videoAttachmentUploadPolicy });
  });

  app.get("/admin/status", async (_req, res) => {
    const status = await getSessionStatus();
    let upstreamOk = false;
    try {
      const r = await fetch(`${config.upstreamUrl}/`, { method: "GET" });
      upstreamOk = r.status < 500;
    } catch {
      upstreamOk = false;
    }
    const cdp = await probeCdp();

    res.json({
      localApiKeyConfigured: Boolean(config.localApiKey),
      upstreamUrl: config.upstreamUrl,
      upstreamOk,
      cdp,
      cdpConfigured: isCdpConfigured(),
      session: {
        present: Boolean(status.sessionId),
        masked: status.masked,
        updatedAt: status.updatedAt,
        hasFullCookie: status.hasFullCookie,
        activeId: status.activeId,
      },
      accounts: status.accounts || [],
      accountCount: status.accountCount || 0,
      loginInProgress: Boolean(loginInFlight),
    });
  });

  app.get("/admin/cdp/status", async (_req, res) => {
    res.json(await probeCdp());
  });

  app.get("/admin/cdp/screenshot", async (_req, res) => {
    try {
      const shot = await captureCdpScreenshot();
      res.json(shot);
    } catch (err) {
      res.status(502).json({
        ok: false,
        message: String(err.message || err),
        tip: "请先用 Edge/Chrome 带 --remote-debugging-port=9222 启动并打开豆包",
      });
    }
  });

  app.get("/admin/logs", async (req, res) => {
    const lines = Math.min(Number(req.query.lines) || 200, 2000);
    const fromDisk = String(req.query.disk || "") === "1";
    if (fromDisk) {
      return res.json(await readLogTail(lines));
    }
    return res.json({
      ok: true,
      file: logger.filePath(),
      lines: logger.recent(lines),
    });
  });

  app.get("/admin/logs/stream", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const send = (entry) => {
      const payload =
        typeof entry === "string"
          ? { line: entry }
          : { line: entry.line, previews: entry.previews || undefined };
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    for (const entry of logger.recent(80)) send(entry);
    res.write(`event: meta\ndata: ${JSON.stringify({ file: logger.filePath() })}\n\n`);

    const off = logger.onLine(send);
    const heartbeat = setInterval(() => {
      res.write(`: ping ${Date.now()}\n\n`);
    }, 15000);

    req.on("close", () => {
      clearInterval(heartbeat);
      off();
    });
  });

  app.get("/admin/ref-preview/:name", (req, res) => {
    const name = String(req.params.name || "");
    if (!/^[a-zA-Z0-9._-]+\.(jpe?g|png|webp)$/i.test(name)) {
      return res.status(400).send("bad name");
    }
    const root = path.resolve(config.dataDir, "ref-previews");
    const file = path.resolve(root, name);
    if (!file.startsWith(root + path.sep) && file !== root) {
      return res.status(400).send("bad path");
    }
    return res.sendFile(file, (err) => {
      if (err) res.status(404).send("not found");
    });
  });

  app.get("/admin/accounts", async (_req, res) => {
    const sweep = await sweepExpiredCooldowns();
    res.json({
      accounts: await listAccounts(),
      checkedAt: sweep.checkedAt,
      clearedCooldowns: sweep.cleared,
    });
  });

  app.post("/admin/accounts/check", async (_req, res) => {
    const sweep = await sweepExpiredCooldowns();
    const status = await getSessionStatus();
    res.json({
      ok: true,
      ...status,
      clearedCooldowns: sweep.cleared,
      checkedAt: sweep.checkedAt,
    });
  });

  app.post("/admin/accounts/:id/clear-cooldown", async (req, res) => {
    try {
      const acc = await clearAccountCooldown(req.params.id);
      res.json({
        ok: true,
        id: acc.id,
        masked: maskSession(acc.sessionId),
        accounts: await listAccounts(),
      });
    } catch (err) {
      res.status(400).json({ ok: false, message: String(err.message || err) });
    }
  });

  app.post("/admin/accounts/active", async (req, res) => {
    try {
      const acc = await setActiveAccount(String(req.body?.id || ""));
      res.json({ ok: true, id: acc.id, masked: maskSession(acc.sessionId) });
    } catch (err) {
      res.status(400).json({ ok: false, message: String(err.message || err) });
    }
  });

  app.delete("/admin/accounts/:id", async (req, res) => {
    await removeAccount(req.params.id);
    res.json({ ok: true, accounts: await listAccounts() });
  });

  app.post("/admin/login", async (req, res) => {
    const switchAccount = Boolean(req.body?.switchAccount || req.query?.switch);
    const result = await startLogin({
      switchAccount,
      label: switchAccount ? `换号 ${new Date().toLocaleString()}` : undefined,
    });
    return res.status(result.status || (result.ok ? 200 : 500)).json(result);
  });

  app.post("/admin/session", async (req, res) => {
    const raw = String(req.body?.sessionId || req.body?.cookie || "").trim();
    if (!raw) {
      return res.status(400).json({ ok: false, message: "请粘贴 sessionid 或整段 Cookie" });
    }
    // 整段 Cookie：同时作为 cookieHeader 传入，避免只剩 sessionid
    const looksLikeCookieJar = /sessionid=/i.test(raw) && raw.includes(";");
    const saved = await upsertAccount(raw, {
      source: "manual",
      cookieHeader: req.body?.cookieHeader
        ? buildCookieHeader(req.body.cookieHeader)
        : looksLikeCookieJar
          ? buildCookieHeader(raw)
          : undefined,
      label: req.body?.label,
      setActive: true,
    });
    // 粘贴新 Cookie 后清掉所有本地冷却（网页能用说明不该被本地锁死）
    await clearAllCooldowns();
    res.json({
      ok: true,
      id: saved.id,
      masked: maskSession(saved.sessionId),
      updatedAt: saved.updatedAt,
      hasFullCookie: Boolean(saved.cookieHeader && saved.cookieHeader.includes(";")),
      cookieCount: (saved.cookieHeader || "").split(";").filter(Boolean).length,
      accounts: await listAccounts(),
    });
  });

  app.post("/admin/accounts/clear-cooldowns", async (_req, res) => {
    const result = await clearAllCooldowns();
    res.json({ ok: true, ...result, accounts: await listAccounts() });
  });

  app.delete("/admin/session", async (_req, res) => {
    await clearSession();
    res.json({ ok: true });
  });

  // 生图：本机直连豆包 + 限流自动换号
  app.post("/v1/images/generations", requireLocalKey, async (req, res) => {
    req.setTimeout?.(300_000);
    res.setTimeout?.(300_000);
    try {
      const body = req.body || {};
      if (/^gpt-image-/i.test(String(body.model || ''))) {
        return res.status(400).json({ error: { type: 'image_client_outdated', submitted: false,
          message: '当前页面的生图脚本已过期，请刷新页面后使用 GPT 生图；本次未提交生成。' } });
      }
      if (!body.prompt) {
        return res.status(400).json({
          error: { message: "prompt 不能为空", type: "invalid_request" },
        });
      }
      logger.info("image request", {
        prompt: String(body.prompt).slice(0, 120),
        model: body.model,
        ratio: body.ratio,
        refs: collectRefImages(body).length,
        imagesIsArray: Array.isArray(body.images),
        imagesLen: Array.isArray(body.images) ? body.images.length : body.images == null ? null : 1,
        hasImageField: Boolean(body.image),
        bodyKeys: Object.keys(body),
        cdp: isCdpEnabled(),
      });
      const { result, account } = await runImageWithFailover(body);
      logger.info("image response", {
        images: result.images?.length || 0,
        account: maskSession(account.sessionId),
      });
      // save: true keeps local copies, since Doubao's signed image links expire.
      let saved;
      if (body.save === true) {
        try {
          saved = (await saveGeneratedImages(result.images)).map(image => ({ path: image.media_path,
            preview_url: `/v1/media/generated/${path.basename(image.file)}`, width: image.width, height: image.height }));
        } catch (error) {
          logger.warn("image save failed", { message: String(error.message || error) });
          saved = [];
        }
      }
      return res.json({
        ...(saved ? { saved } : {}),
        created: Math.floor(Date.now() / 1000),
        id: account.id,
        model: result.model || body.model || "doubao",
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: result.content || "",
              images: result.images,
            },
            finish_reason: "stop",
          },
        ],
        data: result.images.map((url) => ({ url })),
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        account: { id: account.id, masked: maskSession(account.sessionId) },
      });
    } catch (err) {
      const status = err.type === "session_missing" ? 401 : err.type === "rate_limited" ? 429 : 500;
      logger.error("image failed", {
        status,
        type: err.type,
        message: String(err.message || err),
      });
      return res.status(status).json({
        error: {
          message: String(err.message || err),
          type: err.type || "image_generation_failed",
          needSwitchAccount: Boolean(err.needSwitchAccount || err.type === "rate_limited"),
          tried: err.tried || [],
        },
      });
    }
  });

  app.post("/v1/chat/completions", requireLocalKey, (req, res) =>
    proxyJson(req, res, "/v1/chat/completions")
  );

  const handleVideoGeneration = async (req, res) => {
    req.setTimeout?.(600_000);
    res.setTimeout?.(600_000);
    try {
      const body = req.body || {};
      if (!body.prompt) {
        return res.status(400).json({
          error: { message: "prompt 不能为空", type: "invalid_request" },
        });
      }

      if (["doubao-desktop", "enterprise-doubao"].includes(body.provider)) {
        try {
          const started = await startEnterpriseVideoJob(body);
          const waitMs = body.async === true || body.wait === false ? 0 : Math.min(540_000, Math.max(0, Number(body.wait_seconds ?? 540) * 1000));
          const job = waitMs ? await getEnterpriseVideoJob(started.id, { waitMs }) : started;
          const result = enterpriseVideoResponse(job, body.prompt);
          return res.status(job.status === 'completed' ? 200 : job.status === 'running' || job.status === 'submitting' ? 202 : 200).json(result);
        } catch (error) {
          if (error.submitted === false) return res.status(error.httpStatus || 503).json({ error: {
            type: error.code, code: error.code, message: error.message, submitted: false,
            retryable: true, next_action: error.next_action } });
          const invalid = error.invalid || /prompt|duration|ratio|idempotency_key/.test(String(error.message));
          return res.status(invalid ? 400 : 502).json({ error: {
            submitted: invalid ? false : 'unknown', retryable: Boolean(invalid),
            type: invalid ? 'invalid_request' : 'enterprise_video_error',
            message: invalid ? String(error.message) : '企业豆包视频任务暂时不可用；可用已返回的任务 ID 继续查询。',
          } });
        }
      }

      let cookieHeader = "";
      let sessionId = await getUpstreamSessionId(req);
      if (isCdpEnabled()) {
        try {
          const synced = await syncCookiesFromCdp();
          cookieHeader = synced.cookieHeader;
          sessionId = synced.sessionId;
        } catch (err) {
          logger.warn("video cdp sync failed", { message: String(err.message || err) });
        }
      }
      if (!cookieHeader && !sessionId) {
        return res.status(401).json({
          error: {
            message:
              "尚未登录豆包。请保持调试浏览器登录（DOUBAO_USE_CDP=1），或管理页登录。",
            type: "session_missing",
          },
        });
      }
      if (!cookieHeader && sessionId) {
        const store = await listAccounts();
        const acc =
          store.find((a) => a.sessionId === sessionId) ||
          store.find((a) => a.active);
        cookieHeader =
          acc?.cookieHeader ||
          `sessionid=${sessionId}; sessionid_ss=${sessionId}`;
      }

      logger.info("video request", {
        prompt: String(body.prompt).slice(0, 100),
        model: body.model,
        duration: body.duration ?? body.seconds,
        cdp: isCdpEnabled(),
      });

      const result = await generateVideo(sessionId, {
        cookieHeader,
        allowPaid: body.allow_paid === true,
        useCdp: isCdpEnabled(),
        prompt: body.prompt,
        model: body.model,
        duration: body.duration ?? body.seconds,
        ratio: body.ratio || body.aspect_ratio || body.aspectRatio,
        imageKeys: body.imageKeys || body.ref_image_keys || [],
      });
      const url = result.videos?.[0]?.video_url;
      logger.info("video response", {
        videos: result.videos?.length || 0,
        pending: Boolean(result.pending),
        taskId: result.provider_task_id,
      });
      return res.json({
        created: Math.floor(Date.now() / 1000),
        model: result.model,
        status: result.pending ? "processing" : "completed",
        pending: Boolean(result.pending),
        accepted: Boolean(result.accepted || result.pending),
        data: url ? [{ url, revised_prompt: body.prompt }] : [],
        videos: result.videos || [],
        message: result.message,
        estimated_wait_seconds: result.estimated_wait_seconds,
        provider_task_id: result.provider_task_id,
        conversation_id: result.conversation_id,
      });
    } catch (err) {
      const msg = String(err.message || err);
      // 风控/过载不当 pending
      if (
        /出了点问题|疑似包含侵权|违规内容|无法返回该内容|请稍后重试|服务过载/.test(
          msg
        )
      ) {
        logger.error("video failed", { message: msg.slice(0, 200) });
        return res.status(500).json({
          error: {
            message: msg,
            type: /侵权|违规/.test(msg)
              ? "content_policy_blocked"
              : "video_generation_failed",
          },
        });
      }
      logger.error("video failed", { message: msg });
      return res.status(500).json({
        error: {
          message: msg,
          type: err.code === "VIDEO_TASK_UNVERIFIED" ? "video_task_unverified" : "video_generation_failed",
        },
      });
    }
  };

  // Browser uploads stay in the same private media directory used by CLI/MCP.
  const parseFrame = express.raw({ type: ['image/png', 'image/jpeg', 'image/webp', 'application/octet-stream'], limit: '20mb' });
  app.post('/v1/videos/frames', requireLocalKey, (req, res) => {
    parseFrame(req, res, async error => {
      res.set('Cache-Control', 'no-store');
      if (error) return res.status(error.type === 'entity.too.large' ? 413 : 400).json({
        error: { type: 'invalid_frame', message: error.type === 'entity.too.large' ? '图片不能超过 20 MB' : '图片上传失败，请重试。' } });
      try { return res.status(201).json(await storeUploadedFrame(req.body)); }
      catch (error) { return res.status(error.invalid ? 400 : 500).json({ error: {
        type: 'invalid_frame', message: error.invalid ? error.message : '图片保存失败，请重试。' } }); }
    });
  });
  app.get('/v1/videos/frames/:name', requireMediaAccess, async (req, res) => {
    try {
      const frame = await readUploadedFrame(req.params.name);
      if (!frame) return res.status(404).end();
      res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      return res.type(frame.type).send(frame.data);
    } catch { return res.status(500).end(); }
  });

  app.get('/v1/media/:dir/:name', requireMediaAccess, async (req, res) => {
    try {
      const image = await readMediaImage(req.params.dir, req.params.name);
      if (!image) return res.status(404).end();
      res.set({ 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
      return res.type(image.type).send(image.data);
    } catch { return res.status(500).end(); }
  });

  // One SSE stream for many video tasks, so a canvas with several running
  // videos does not exhaust the browser's per-host connection limit.
  app.get("/v1/videos/events", requireLocalKey, async (req, res) => {
    const ids = [...new Set(String(req.query.ids || '').split(',').filter(id => /^(?:[0-9a-f-]{36}|[0-9a-f]{64})$/.test(id)))].slice(0, 50);
    if (!ids.length) return res.status(400).json({ error: { type: 'invalid_request', message: 'ids 不能为空' } });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
    req.setTimeout?.(0);
    const sent = new Map();
    let closed = false, checking = false;
    const send = current => {
      if (closed) return;
      const state = JSON.stringify([current.status, current.phase, current.error, current.videos, current.pending, current.message]);
      if (sent.get(current.id) === state) return;
      sent.set(current.id, state);
      res.write(`event: status\ndata: ${JSON.stringify(enterpriseVideoResponse(current))}\n\n`);
    };
    for (const id of ids) jobEvents.on(id, send);
    const heartbeat = setInterval(async () => {
      if (closed || checking) return;
      checking = true;
      try {
        res.write(': keep-alive\n\n');
        // Catch changes written by the watcher in another gateway process.
        for (const id of ids) { const current = await getEnterpriseVideoJob(id).catch(() => null); if (current) send(current); }
      } finally { checking = false; }
    }, 15_000);
    req.on('close', () => { closed = true; clearInterval(heartbeat); for (const id of ids) jobEvents.off(id, send); });
    for (const id of ids) {
      const job = await getEnterpriseVideoJob(id).catch(() => null);
      if (job) send(job);
      else send({ id, status: 'failed', phase: null, created_at: new Date().toISOString(),
        message: '任务记录不存在，无法读取这张视频卡片。', error: { code: 'task_not_found' }, videos: [] });
    }
  });

  const generateImageJob = (body, options) => body.provider === 'doubao-desktop'
    ? generateEnterpriseImage(body, options) : body.provider === 'openai-compatible' ? generateCompatibleImage(body,options) : runImageWithFailover(body).then(r => r.result);
  resumeImageJobs(generateImageJob).catch(() => {});

  // Background image jobs: the canvas keeps the job id, so a reload resumes waiting.
  app.post('/v1/images/jobs', requireLocalKey, async (req, res) => {
    try {
      const job = await startImageJob(req.body || {}, generateImageJob);
      return res.status(202).json(job);
    } catch (error) {
      return res.status(error.invalid ? 400 : 500).json({ error: { type: 'image_job_error', message: error.invalid ? error.message : '图片任务创建失败。',submitted:error.invalid ? false : 'unknown' } });
    }
  });
  app.get('/v1/images/jobs/:id', requireLocalKey, async (req, res) => {
    try {
      const job = await getImageJob(req.params.id, { waitMs: Math.min(60, Math.max(0, Number(req.query.wait_seconds) || 0)) * 1000, refresh: req.query.refresh === '1' });
      return job ? res.status(job.status === 'running' ? 202 : 200).json(job)
        : res.status(404).json({ error: { type: 'image_job_not_found', message: '图片任务不存在' } });
    } catch { return res.status(500).json({ error: { type: 'image_job_error', message: '图片任务查询失败。' } }); }
  });
  app.get('/v1/media', requireLocalKey, async (req, res) => {
    try { return res.json({ images: await listMediaImages(String(req.query.dir || 'generated'), Number(req.query.limit) || 60) }); }
    catch { return res.status(500).json({ error: { type: 'media_error', message: '素材读取失败。' } }); }
  });
  app.get('/v1/images/capabilities',requireLocalKey,async(req,res)=>{
    try {res.json(await imageCapabilities({probe:req.query.probe==='1'}));}catch {res.status(500).json({error:{message:'生图配置暂时不可读'}});}
  });
  app.post('/v1/images/provider',requireLocalKey,async(req,res)=>{
    try {res.json(await saveImageProviderSettings(req.body || {}));}catch(error) {res.status(error.invalid?400:500).json({error:{message:error.invalid?error.message:'生图配置保存失败',submitted:false}});}
  });
  app.post('/v1/images/jobs/:id/cancel',requireLocalKey,async(req,res)=>{
    try {const job=await cancelImageJob(req.params.id);res.status(job?200:404).json(job || {error:{message:'图片任务不存在',submitted:false}});}catch {res.status(502).json({error:{message:'取消结果未知，请查询原任务',submitted:'unknown'}});}
  });
  app.post('/v1/videos/tasks/:id/cancel',requireLocalKey,async(req,res)=>{
    try {const job=await cancelEnterpriseVideoJob(req.params.id);res.status(job?200:404).json(job ? enterpriseVideoResponse(job) : {error:{message:'视频任务不存在',submitted:false}});}catch {res.status(502).json({error:{message:'取消结果未知，请查询原任务',submitted:'unknown'}});}
  });

  app.get('/v1/canvases', requireLocalKey, async (_req, res) => {
    try { return res.json({ canvases: await listCanvases() }); }
    catch { return res.status(500).json({ error: { type: 'canvas_error', message: '暂时无法读取画布列表。' } }); }
  });
  app.post('/v1/canvases', requireLocalKey, async (req, res) => {
    try { return res.status(201).json(await createCanvas(req.body || {})); }
    catch (error) { return res.status(error.invalid ? 400 : 500).json({ error: { type: 'canvas_error', message: error.invalid ? error.message : '画布创建失败。' } }); }
  });
  app.get('/v1/canvases/:id', requireLocalKey, async (req, res) => {
    try {
      const doc = await getCanvas(req.params.id);
      return doc ? res.json(doc) : res.status(404).json({ error: { type: 'canvas_not_found', message: '画布不存在' } });
    } catch { return res.status(500).json({ error: { type: 'canvas_error', message: '画布读取失败。' } }); }
  });
  app.get('/v1/canvases/:id/video-scenes', requireLocalKey, async (req, res) => {
    try {
      const doc = await getCanvas(req.params.id);
      return doc ? res.json(canvasSceneSummary(doc)) : res.status(404).json({ error: { type: 'canvas_not_found', message: '画布不存在' } });
    } catch { return res.status(500).json({ error: { type: 'canvas_error', message: '画布读取失败。' } }); }
  });
  app.post('/v1/canvases/:id/video-scenes', requireLocalKey, async (req, res) => {
    try {
      const result = await composeVideoScene(req.params.id, req.body || {});
      return result ? res.status(201).json(result) : res.status(404).json({ error: { type: 'canvas_not_found', message: '画布不存在' } });
    } catch (error) { return res.status(error.invalid ? 400 : 500).json({ error: { type: 'canvas_error', message: error.invalid ? error.message : '镜头保存失败。', submitted: false } }); }
  });
  app.post('/v1/canvases/:id/video-scenes/:cardId/generate', requireLocalKey, async (req, res) => {
    let input;
    try {
      const doc = await getCanvas(req.params.id);
      if (!doc) return res.status(404).json({ error: { type: 'canvas_not_found', message: '画布不存在', submitted: false } });
      const card = doc.cards.find(c => c.id === req.params.cardId && c.type === 'video');
      if (card?.task_id) {
        const existing = await getEnterpriseVideoJob(card.task_id);
        if (existing) return res.json(enterpriseVideoResponse(existing));
        if (!card.request_key) return res.status(409).json({ error: { type: 'task_missing', message: '原任务暂时不可读，请查询原编号；不要重新生成。', submitted: 'unknown', task_id: card.task_id } });
      }
      input = await reserveVideoScene(req.params.id, req.params.cardId);
      if (!input) return res.status(404).json({ error: { type: 'canvas_not_found', message: '画布不存在', submitted: false } });
      const job = await startEnterpriseVideoJob({ ...input, provider: 'doubao-desktop', async: true,
        first_frame: input.first_frame || undefined, last_frame: input.last_frame || undefined });
      return res.status(job.status === 'completed' ? 200 : 202).json(enterpriseVideoResponse(job));
    } catch (error) {
      const rejected = error.invalid || error.submitted === false;
      if (rejected && input) await releaseRejectedScene(req.params.id, req.params.cardId, input.idempotency_key).catch(() => {});
      return res.status(rejected ? (error.httpStatus || 400) : 502).json({ error: {
        type: error.code || 'canvas_video_error', message: rejected ? error.message : '任务结果暂时无法确认，请查询原任务编号。',
        submitted: rejected ? false : 'unknown', ...(input ? { task_id: input.task_id } : {}) } });
    }
  });
  app.delete('/v1/canvases/:id', requireLocalKey, async (req, res) => {
    try { return (await deleteCanvas(req.params.id)) ? res.status(204).end() : res.status(404).json({ error: { type: 'canvas_not_found', message: '画布不存在' } }); }
    catch { return res.status(500).json({ error: { type: 'canvas_error', message: '画布删除失败。' } }); }
  });
  app.put('/v1/canvases/:id', requireLocalKey, async (req, res) => {
    try {
      const doc = await saveCanvas(req.params.id, req.body || {});
      return doc ? res.json(doc) : res.status(404).json({ error: { type: 'canvas_not_found', message: '画布不存在' } });
    } catch (error) {
      if (error.conflict) return res.status(409).json({ error: { type: 'canvas_conflict', message: '画布已在其他窗口修改。' }, current: error.current });
      return res.status(error.invalid ? 400 : 500).json({ error: { type: 'canvas_error', message: error.invalid ? error.message : '画布保存失败。' } });
    }
  });

  app.post("/v1/videos/generations", requireLocalKey, handleVideoGeneration);
  app.post("/v1/videos", requireLocalKey, handleVideoGeneration);
  app.post("/v1/video/generations", requireLocalKey, handleVideoGeneration);

  app.get('/v1/videos/readiness', requireLocalKey, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    return res.json(await getVideoReadiness({ force: req.query.refresh === '1' }));
  });

  app.get("/v1/videos/tasks", requireLocalKey, async (req, res) => {
    try {
      const limit = Math.max(1, Math.min(100, Math.floor(Number(req.query.limit) || 100)));
      const before = String(req.query.before || '');
      if (before && !/^(?:[0-9a-f-]{36}|[0-9a-f]{64})$/.test(before)) return res.status(400).json({ error: { message: '分页任务编号无效。' } });
      const tasks = await listEnterpriseVideoJobs({ limit: limit + 1, before });
      return res.json({ tasks: tasks.slice(0, limit), next_cursor: tasks.length > limit ? tasks[limit - 1].task_id : null });
    }
    catch { return res.status(502).json({ error: { type: 'task_list_error', message: '暂时无法读取作品列表。' } }); }
  });

  app.get("/v1/videos/tasks/:id", requireLocalKey, async (req, res) => {
    try {
      const waitMs = Math.min(60_000, Math.max(0, Number(req.query.wait_seconds || 0) * 1000));
      const job = req.query.refresh === '1'
        ? await refreshEnterpriseVideoJob(req.params.id)
        : await getEnterpriseVideoJob(req.params.id, { waitMs });
      if (!job) return res.status(404).json({ error: { type: 'task_not_found', message: '视频任务不存在' } });
      return res.status(job.status === 'completed' ? 200 : 202).json(enterpriseVideoResponse(job));
    } catch {
      return res.status(502).json({ error: { type: 'enterprise_video_error', message: '视频任务查询暂时失败，请稍后重试。' } });
    }
  });

  // Server-sent status updates for one task; closes once the task stops moving.
  app.get("/v1/videos/tasks/:id/events", requireLocalKey, async (req, res) => {
    let job;
    try { job = await getEnterpriseVideoJob(req.params.id); }
    catch { return res.status(502).json({ error: { type: 'enterprise_video_error', message: '视频任务查询暂时失败，请稍后重试。' } }); }
    if (!job) return res.status(404).json({ error: { type: 'task_not_found', message: '视频任务不存在' } });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
    req.setTimeout?.(0);
    const id = job.id;
    let closed = false, checking = false, sent;
    const send = current => {
      if (closed) return;
      const state = JSON.stringify([current.status, current.phase, current.error, current.videos, current.pending, current.message]);
      if (sent === state) return;
      sent = state;
      res.write(`event: status\ndata: ${JSON.stringify(enterpriseVideoResponse(current))}\n\n`);
      if (!followsVideoTask(current)) close();
    };
    const heartbeat = setInterval(async () => {
      if (closed || checking) return;
      checking = true;
      try {
        res.write(': keep-alive\n\n');
        const current = await getEnterpriseVideoJob(id).catch(() => null);
        if (current) send(current);
      } finally { checking = false; }
    }, 15_000);
    const close = () => { if (closed) return; closed = true; clearInterval(heartbeat); jobEvents.off(id, send); res.end(); };
    jobEvents.on(id, send);
    req.on('close', close);
    send(job);
  });

  app.post("/v1/videos/recover", requireLocalKey, async (req, res) => {
    try {
      const job = await recoverEnterpriseVideoJob(req.body?.conversation_id, req.body?.run_id);
      return res.status(job.status === 'completed' ? 200 : 202).json(enterpriseVideoResponse(job));
    } catch {
      return res.status(400).json({ error: { type: 'invalid_recovery', message: '无法恢复指定会话和 run。' } });
    }
  });

  app.get('/v1/videos/files/:id/source', requireLocalKey, async (req, res) => {
    let source;
    try { source = await enterpriseVideoSource(req.params.id); } catch { return res.status(502).json({ error: { message: '视频来源读取失败。' } }); }
    res.set('Cache-Control', 'no-store');
    return source ? res.json(source) : res.status(409).json({ error: { message: '旧视频尚未核验云盘来源。请重新提取原任务的云盘版本。' } });
  });

  app.get("/v1/videos/files/:id", requireMediaAccess, async (req, res) => {
    const file = await enterpriseVideoFile(req.params.id);
    if (!file) return res.status(404).end();
    res.type('video/mp4').sendFile(file);
  });

  app.post("/token/check", requireLocalKey, async (req, res) => {
    const session = await loadSession();
    const token = req.body?.token || session?.sessionId;
    if (!token) {
      return res.status(400).json({ live: false, error: "no session" });
    }
    try {
      const r = await fetch(`${config.upstreamUrl}/token/check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = await r.json();
      return res.status(r.status).json(data);
    } catch (err) {
      return res.status(502).json({ live: false, error: String(err.message || err) });
    }
  });

  return app;
}
