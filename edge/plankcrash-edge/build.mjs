// Stage public/arcade as the edge asset tree. HTML and the manifests stay
// origin-only (see ORIGIN_ONLY in src/index.js); everything else ships.
import { cpSync, rmSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
const src = new URL("../../public/arcade", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const dst = new URL("./dist/arcade", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
rmSync(new URL("./dist", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), { recursive: true, force: true });
mkdirSync(dst, { recursive: true });
const skip = (p) => /\.html$/i.test(p) || /deploy-addresses\.[a-z]+\.json$/i.test(p) || /\.png$/i.test(p) && /(launch-coast|cosmic-relics|chalkstronaut-front|titanium)\.png$/i.test(p);
cpSync(src, dst, { recursive: true, filter: (s) => !skip(s) });
let n = 0, bytes = 0;
const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); const st = statSync(p); if (st.isDirectory()) walk(p); else { n++; bytes += st.size; } } };
walk(dst);
console.log(`edge assets: ${n} files, ${(bytes / 1048576).toFixed(1)} MB -> ${dst}`);
