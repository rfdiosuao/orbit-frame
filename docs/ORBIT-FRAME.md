# 轨映 · Orbit Frame

The home page at `http://127.0.0.1:8787/` is a local video creation interface. It keeps the relay's existing endpoints and advanced management page (`/legacy.html`). Video creation uses the `doubao-desktop` provider, requests `Seedance 2.0 Fast`, accepts 1–15 seconds and 16:9, 9:16, 1:1, 4:3 or 3:4 framing. Download format is MP4.

The browser sends an authenticated `POST /v1/videos/generations` with a persisted idempotency key. It then queries the returned task ID, including after refresh. The video preview and download fetch `/v1/videos/files/:id` with the Bearer header, convert the response to a Blob and use a local object URL. A task is shown as complete only when it has a valid video ID and its file can be fetched. The works library reads authenticated, restricted metadata from `GET /v1/videos/tasks`; older recovered tasks without prompts receive date-based titles.

The connection page reads an existing `doubao_local_api_key` browser value for compatibility. Newly entered keys stay in page memory unless “记住这台设备” is checked. The advanced page displays a placeholder in its example command. Do not add keys to URLs or server-rendered HTML.

HEANG design system assets under `public/heang/` are copied from `heang-design@0.1.0` (MIT). The page imports its tokens, motion CSS, `initPointerFX` and `runSplash`. The local splash uses the same `orbit-frame.svg` as the header and favicon. To refresh the assets, install the desired version with `npm install heang-design --registry=https://registry.npmmirror.com`, then copy the package's `assets/tokens.css`, `assets/motion.css`, `dist/index.js` and `LICENSE` together. The page's splash CSS intentionally uses `data-mode="sky"` and `data-mode="space"` consistently with the tokens.

Verification: `node --check public/app.js`, `node tests/video-response-regression.mjs`, `node tests/enterprise-video-extraction.mjs`, `node tests/video-library-safety.mjs`. A real video submission must still be verified in a browser with the local service and a valid client session.
