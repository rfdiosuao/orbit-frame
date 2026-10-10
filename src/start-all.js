import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";

process.umask(0o077);
const root = config.root;
const freeApiDir = path.join(root, "vendor", "doubao-free-api");
const freeApiEntry = path.join(freeApiDir, "dist", "index.js");
const children = new Set();
let stopping = false;

function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) child.kill("SIGTERM");
  // A failed child must not leave its sibling holding the next startup's port.
  setTimeout(() => {
    for (const child of children) child.kill("SIGKILL");
  }, 3000).unref();
}
process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());

function run(name, command, args, cwd) {
  const child = spawn(command, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: process.env,
  });
  children.add(child);
  child.on("error", () => {
    children.delete(child);
    console.error(`[${name}] failed to start`);
    shutdown(1);
  });
  child.on("exit", (code, signal) => {
    children.delete(child);
    console.log(`[${name}] exited code=${code} signal=${signal}`);
    if (!stopping) shutdown(code || 1);
  });
  return child;
}

console.log("[start] 启动上游 doubao-free-api（本机 Node，无 Docker）…");
run(
  "free-api",
  process.execPath,
  ["--enable-source-maps", "--no-node-snapshot", freeApiEntry],
  freeApiDir
);

// 稍等上游起来再开网关
await new Promise((r) => setTimeout(r, 1500));

if (!stopping) {
  console.log("[start] 启动本机网关…");
  run("gateway", process.execPath, [path.join(root, "src", "index.js")], root);
}
