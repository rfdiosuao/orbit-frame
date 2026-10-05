// src/pointer.ts
var CLICKABLE = "a[href], button, [role='button'], input, select, textarea, summary, label, [data-magnetic]";
function initPointerFX({
  magnetic = ".h-btn, [data-magnetic]",
  tilt = ".lift, [data-tilt]",
  spotlight = ".stk",
  tiltDeg = 4,
  pull = 6
} = {}) {
  const fine = matchMedia("(hover: hover) and (pointer: fine)");
  const reduce = matchMedia("(prefers-reduced-motion: reduce)");
  if (!fine.matches || reduce.matches || document.documentElement.classList.contains("heang-fx")) return () => {
  };
  const root = document.documentElement;
  root.classList.add("heang-fx");
  const ring = document.createElement("div");
  ring.className = "hfx-ring";
  ring.setAttribute("aria-hidden", "true");
  document.body.appendChild(ring);
  let px = -100, py = -100;
  let rx = px, ry = py;
  let pending = null;
  let frame = 0;
  let magEl = null;
  let tiltEl = null;
  let lightEl = null;
  const clamp = (v, m) => Math.max(-m, Math.min(m, v));
  function release(el, kind) {
    if (!el) return;
    if (kind === "mag") el.style.translate = "";
    if (kind === "tilt") el.style.rotate = "";
    if (kind === "light") el.style.removeProperty("--hfx-x"), el.style.removeProperty("--hfx-y");
  }
  function apply(e) {
    const t = e.target instanceof Element ? e.target : null;
    const m = t?.closest(magnetic) ?? null;
    if (m !== magEl) release(magEl, "mag"), magEl = m;
    if (m) {
      const r = m.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      m.style.translate = `${clamp(dx * 0.18, pull).toFixed(1)}px ${clamp(dy * 0.28, pull * 0.8).toFixed(1)}px`;
    }
    const c = t?.closest(tilt) ?? null;
    if (c !== tiltEl) release(tiltEl, "tilt"), tiltEl = c;
    if (c) {
      const r = c.getBoundingClientRect();
      const nx = (e.clientX - r.left) / r.width - 0.5;
      const ny = (e.clientY - r.top) / r.height - 0.5;
      const deg = Math.min(1, Math.hypot(nx, ny) * 2) * tiltDeg;
      c.style.rotate = deg < 0.15 ? "" : `${(-ny).toFixed(3)} ${nx.toFixed(3)} 0 ${deg.toFixed(2)}deg`;
    }
    const s = t?.closest(spotlight) ?? null;
    if (s !== lightEl) release(lightEl, "light"), lightEl = s;
    if (s) {
      const r = s.getBoundingClientRect();
      s.style.setProperty("--hfx-x", `${(e.clientX - r.left).toFixed(0)}px`);
      s.style.setProperty("--hfx-y", `${(e.clientY - r.top).toFixed(0)}px`);
    }
    ring.classList.toggle("is-hot", !!t?.closest(CLICKABLE));
  }
  function loop() {
    frame = 0;
    if (pending) apply(pending), pending = null;
    rx += (px - rx) * 0.22;
    ry += (py - ry) * 0.22;
    ring.style.translate = `${rx.toFixed(1)}px ${ry.toFixed(1)}px`;
    if (Math.abs(px - rx) > 0.3 || Math.abs(py - ry) > 0.3) frame = requestAnimationFrame(loop);
  }
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(loop);
  };
  const onMove = (e) => {
    if (e.pointerType !== "mouse") return;
    px = e.clientX;
    py = e.clientY;
    pending = e;
    ring.classList.add("is-on");
    schedule();
  };
  const onDown = (e) => {
    if (e.pointerType !== "mouse" || e.button !== 0) return;
    ring.classList.add("is-down");
    const b = document.createElement("div");
    b.className = "hfx-burst";
    b.setAttribute("aria-hidden", "true");
    b.style.translate = `${e.clientX}px ${e.clientY}px`;
    document.body.appendChild(b);
    window.setTimeout(() => b.remove(), 700);
  };
  const onUp = () => ring.classList.remove("is-down");
  const onLeave = (e) => {
    if (e.relatedTarget) return;
    ring.classList.remove("is-on");
    release(magEl, "mag"), release(tiltEl, "tilt"), release(lightEl, "light");
    magEl = tiltEl = lightEl = null;
  };
  window.addEventListener("pointermove", onMove, { passive: true });
  window.addEventListener("pointerdown", onDown, { passive: true });
  window.addEventListener("pointerup", onUp, { passive: true });
  document.addEventListener("mouseout", onLeave, { passive: true });
  return () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerdown", onDown);
    window.removeEventListener("pointerup", onUp);
    document.removeEventListener("mouseout", onLeave);
    cancelAnimationFrame(frame);
    release(magEl, "mag"), release(tiltEl, "tilt"), release(lightEl, "light");
    ring.remove();
    root.classList.remove("heang-fx");
  };
}

// src/splash.ts
var FLY_MS = 640;
var FADE_MS = 420;
function runSplash({ target = "[data-heang-logo]", minMs = 700, maxMs = 8e3 } = {}) {
  const splash = document.getElementById("heang-splash");
  if (!splash || splash.dataset.running) return;
  splash.dataset.running = "1";
  const mark = splash.querySelector(".hs-mark");
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let fontsReady = !document.fonts;
  document.fonts?.ready.then(() => fontsReady = true);
  const onScreen = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 4 && r.bottom > 0 && r.top < innerHeight;
  };
  const tick = () => {
    const t = performance.now();
    const logo = document.querySelector(target);
    const ready = document.readyState === "complete" && fontsReady && !document.querySelector("[data-heang-loading]") && !!logo && onScreen(logo);
    if (t > maxMs || t > minMs && ready) land(ready ? logo : null);
    else window.setTimeout(tick, 80);
  };
  function land(logo) {
    splash.classList.add("hs-done");
    if (!logo || !mark || reduce) return reveal();
    const from = mark.getBoundingClientRect();
    const to = logo.getBoundingClientRect();
    const dx = to.left + to.width / 2 - (from.left + from.width / 2);
    const dy = to.top + to.height / 2 - (from.top + from.height / 2);
    logo.style.visibility = "hidden";
    mark.style.transform = `translate(${dx}px, ${dy}px) scale(${to.width / from.width})`;
    window.setTimeout(() => {
      logo.style.visibility = "";
      reveal();
    }, FLY_MS);
  }
  function reveal() {
    splash.classList.add("hs-reveal");
    window.setTimeout(() => splash.remove(), FADE_MS + 60);
  }
  tick();
}
export {
  initPointerFX,
  runSplash
};
