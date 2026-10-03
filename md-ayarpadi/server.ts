import { readFileSync } from "fs";
import { join } from "path";

const html = readFileSync(join(import.meta.dir, "index.html"), "utf-8");

Bun.serve({
  port: parseInt(process.env.PORT || "3000"),
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    return new Response("Not Found", { status: 404 });
  },
});

console.log(`md-ayarpadi running on :${process.env.PORT || 3000}`);
