// Starts the web app and the durable worker together. One command: `npm start` (or `npm run dev`).
import { spawn } from "node:child_process";
import fs from "node:fs";

const mode = process.argv[2] === "dev" ? "dev" : "start";
const host = process.env.HOST || "127.0.0.1";
const port = process.env.PORT || "3000";
if (!["127.0.0.1", "localhost", "::1"].includes(host) && process.env.ALLOW_NETWORK !== "1") {
  console.error(`Refusing to bind to ${host}. Network exposure requires ALLOW_NETWORK=1 and HTTPS in front (see README › Deployment).`);
  process.exit(1);
}
if (mode === "start" && !fs.existsSync(".next/BUILD_ID")) {
  console.error("No production build found. Run `npm run build` first (or `npm run setup`).");
  process.exit(1);
}
const isWin = process.platform === "win32";
const bin = (n) => (isWin ? `${n}.cmd` : n);
const run = (name, cmd, args) => {
  const p = spawn(bin(cmd), args, { stdio: "inherit", env: process.env, shell: isWin });
  p.on("exit", (code) => {
    console.log(`[run] ${name} exited with ${code}`);
    shutdown(code ?? 1);
  });
  return p;
};
const children = [];
let down = false;
function shutdown(code) {
  if (down) return;
  down = true;
  for (const c of children) if (!c.killed) c.kill("SIGTERM");
  setTimeout(() => process.exit(code), 3000);
}
const mig = spawn(bin("npx"), ["tsx", "scripts/migrate.ts"], { stdio: "inherit", env: process.env, shell: isWin });
mig.on("exit", (code) => {
  if (code !== 0) process.exit(code ?? 1);
  children.push(run("web", "npx", ["next", mode, "-H", host, "-p", port]));
  children.push(run("worker", "npx", ["tsx", "worker/index.ts"]));
  console.log(`[run] Outlier Media OS on http://${host}:${port} — web + worker running. Ctrl+C stops both.`);
});
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
