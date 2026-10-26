// The e2e fixture app. The page origin is http://127.0.0.1:$PORT; http://localhost:$PORT+1 is another origin
// that sends no CORS headers. It accepts connections at once but prints its ready line only after a delay,
// answering 503 until then, so a runner that starts tests on the open port alone gets a broken page.
const port = Number(process.env.PORT);
const app = `http://127.0.0.1:${port}`;
const other = `http://localhost:${port + 1}`;
const asset = (name: string) => Bun.file(new URL(`./assets/${name}`, import.meta.url));
let ready = false;
let changing = 0;

const html = (body: string, head = "") =>
  new Response(`<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`, {
    headers: { "content-type": "text/html" },
  });

const pages: Record<string, () => Response | Promise<Response>> = {
  "/": () =>
    html(`<h1>Fixture home</h1><p data-ui-verify="${process.env.UI_VERIFY ?? ""}">served</p><p id="port">port ${port}</p>`),
  "/locators": () =>
    html(`
      <h1>Locators</h1>
      <label for="email">Email address</label><input id="email" placeholder="you@example.com">
      <label>Wrapped name <input id="wrapped"></label>
      <span id="ext">External label</span><input id="labelled" aria-labelledby="ext">
      <input id="aria" aria-label="Search everything">
      <button disabled>Disabled action</button>
      <button aria-pressed="true">Bold</button>
      <input type="checkbox" aria-label="Checked box" checked><input type="checkbox" aria-label="Unchecked box">
      <div role="tablist"><button role="tab" aria-selected="true">First tab</button><button role="tab" aria-selected="false">Second tab</button></div>
      <div oncontextmenu="event.preventDefault(); this.dataset.menu = 'opened'">Right-click target</div>
      <div data-testid="the-box">Box <span>inner text</span></div>
      <div id="editable" contenteditable>old text</div>
      <fieldset id="scope"><label for="inner">Inner field</label><input id="inner" placeholder="Scoped placeholder"><button>Scoped button</button><span data-testid="scoped">in scope</span></fieldset>
      <label for="outer">Inner field</label><input id="outer" placeholder="Scoped placeholder"><button>Scoped button</button><span data-testid="scoped">out of scope</span>
      <ul><li>First item</li><li>Second item</li></ul>
      <a href="/">Home link</a>`),
  "/scroll": () =>
    html(`<div style="height:2000px">tall</div><button style="display:block;height:40px"
      onclick="document.body.dataset.scrollY = String(scrollY)">Far button</button><div style="height:2000px"></div>`),
  "/resources": () =>
    html(
      `<h1 style="font-family: Fixture">A</h1>
       <p style="font-family: 'Cross Fixture'">A</p>
       <div class="bg" style="width:10px;height:10px"></div>
       <img src="/red.png" width="10" height="10">
       <img src="${other}/cross.png" width="10" height="10">
       <img src="${other}/redirect.png" width="10" height="10">
       <div style="height:3000px"></div>
       <img src="/lazy.png" loading="lazy" width="10" height="10">
       <img id="blob" width="10" height="10">
       <script>
         fetch("/blue.png").then((r) => r.blob()).then((b) => {
           document.getElementById("blob").src = URL.createObjectURL(b);
         });
       </script>`,
      `<link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="${other}/cross.css">`,
    ),
  "/style.css": () =>
    new Response(`@font-face { font-family: Fixture; src: url(/font.ttf) format("truetype"); } .bg { background: url(/bg.png); }`, {
      headers: { "content-type": "text/css" },
    }),
  "/font.ttf": () => new Response(asset("font.ttf"), { headers: { "content-type": "font/ttf" } }),
  "/red.png": () => new Response(asset("red.png"), { headers: { "content-type": "image/png" } }),
  "/bg.png": () => new Response(asset("blue.png"), { headers: { "content-type": "image/png" } }),
  "/lazy.png": () => new Response(asset("red.png"), { headers: { "content-type": "image/png" } }),
  "/blue.png": () => new Response(asset("blue.png"), { headers: { "content-type": "image/png" } }),
  "/api/items": () => Response.json(["from the server"]),
  "/api/secret": () => Response.json({ secret: "not a visual asset" }),
  "/timers": () =>
    html(`<h1>Timers</h1><ul id="stamps"></ul>
      <button onclick="setTimeout(() => document.body.append(Object.assign(document.createElement('p'), { textContent: 'Timer fired' })), 50)">Start timer</button>
      <button onclick="document.getElementById('stamps').append(Object.assign(document.createElement('li'), { textContent: String(Date.now()) }))">Stamp</button>
      <button onclick="window.cancelable = setTimeout(() => document.body.append(Object.assign(document.createElement('p'), { textContent: 'Cancelled timer fired' })), 50)">Start cancelable</button>
      <button onclick="clearTimeout(window.cancelable)">Cancel</button>
      <button onclick="setTimeout(() => { throw new Error('timer threw'); }, 50); setTimeout(() => document.body.append(Object.assign(document.createElement('p'), { textContent: 'Second timer ran' })), 50)">Two timers</button>`),
  "/detached-frame": () =>
    html(`<h1>Detached frame</h1><script>
      const frame = Object.assign(document.createElement("iframe"), { src: "/never-answered-frame" });
      document.body.append(frame);
      setTimeout(() => { frame.remove(); document.body.append(Object.assign(document.createElement("p"), { textContent: "Frame removed" })); }, 300);
    </script>`),
  "/load-earlier": () => html(`<h1>Loads an image</h1><img src="${other}/earlier.png" width="10" height="10">`),
  "/ask-earlier": () =>
    html(`<h1>Asks</h1><p id="answer"></p><script>
      const helpers = window.__vt;
      const answer = helpers.answerOutside;
      helpers.answerOutside = (id, result) => {
        if (id !== 424242) return answer(id, result);
        document.getElementById("answer").textContent = "error" in result ? "refused" : "bytes";
      };
      window.__uiverifyOutsidePage(JSON.stringify({ id: 424242, url: "${other}/earlier.png" }));
    </script>`),
  "/environment": () =>
    html(`<h1>Environment</h1><p id="env"></p><script>
      document.getElementById("env").textContent = JSON.stringify({
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        locale: Intl.DateTimeFormat().resolvedOptions().locale,
        language: navigator.language,
        languages: navigator.languages,
        reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
      });
      fetch("/accept-language").then((r) => r.text()).then((header) => {
        document.body.append(Object.assign(document.createElement("p"), { textContent: "accept: " + header }));
      });
    </script>`),
  "/routed-once-image": () =>
    html(`<h1>Routed once</h1><img src="${other}/routed-once.png" width="10" height="10">`),
  "/marked": () =>
    html(`<h1>Marked</h1><p data-vt-ref="app-owned">App-owned mark</p><p data-vt-ref="1">App's mark one</p>
      <div id="panel"><span>Panel text</span></div>
      <button onclick="window.held ? (document.body.append(held), window.held = null) : (window.held = panel, panel.remove())">Toggle panel</button>
      <button onclick="window.heldCopy = counter.cloneNode(true)">Hold a copy</button>
      <button onclick="heldCopy.id = 'held-copy'; document.body.append(heldCopy)">Attach the copy</button>
      <button id="counter" onclick="this.dataset.clicks = Number(this.dataset.clicks ?? 0) + 1">Count</button>
      <button onclick="const copy = counter.cloneNode(true); copy.id = 'copy' + (window.copies = (window.copies ?? 0) + 1); document.body.prepend(copy)">Copy the counter</button>`),
  "/reloaded-image": () =>
    html(`<h1>Reloaded image</h1><img src="${other}/changing.png" width="10" height="10">`),
  "/logo.svg": () =>
    new Response('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>', {
      headers: { "content-type": "image/svg+xml" },
    }),
  "/svg-embed": () => html(`<h1>SVG embed</h1><object type="image/svg+xml" data="/logo.svg" width="10" height="10"></object>`),
  "/shadow": () =>
    html(`<h1>Shadow</h1><shadow-host></shadow-host><script>
      customElements.define("shadow-host", class extends HTMLElement {
        connectedCallback() {
          const button = Object.assign(document.createElement("button"), { textContent: "Shadow button" });
          button.addEventListener("click", () => this.setAttribute("data-clicked", "yes"));
          this.attachShadow({ mode: "open" }).append(button);
        }
      });
    </script>`),
  "/hash": () =>
    html(`<h1>Hash</h1><p id="hash"></p><script>
      const show = () => (document.getElementById("hash").textContent = "hash " + location.hash);
      addEventListener("hashchange", show);
      show();
    </script>`),
  "/string-timer": () => html(`<h1>String timer</h1><script>setTimeout("document.body.dataset.ran = 'yes'", 10);</script>`),
  "/to-other-origin": () => html(`<a href="${other}/store">To the other origin</a>`),
  "/rejection": () => html(`<h1>Rejection</h1><script>Promise.reject(new Error("an unhandled rejection"));</script>`),
  "/routed": () =>
    html(`<h1>Routed</h1><ul id="items"></ul><p id="init"></p><script>
      document.getElementById("init").textContent = String(window.__initScript ?? "none");
      fetch("/api/items").then((r) => r.json()).then((items) => {
        for (const item of items) document.getElementById("items").append(Object.assign(document.createElement("li"), { textContent: item }));
      });</script>`),
  "/isolation": () =>
    html(`<h1>Isolation</h1><p id="state"></p><script>
      document.getElementById("state").textContent = JSON.stringify({
        storage: localStorage.getItem("left-behind"),
        cookie: document.cookie,
        history: history.length,
        name: window.name,
        init: window.__initScript ?? null,
      });</script>`),
  "/random": () => html(`<p id="random"></p><script>document.getElementById("random").textContent = String(Math.random());</script>`),
  "/clock": () => html(`<p id="now"></p><a href="/clock2">next</a><script>document.getElementById("now").textContent = new Date().toISOString();</script>`),
  "/clock2": () => html(`<h1>Second document</h1><p id="now"></p><script>document.getElementById("now").textContent = new Date().toISOString();</script>`),
  "/scheme": () => html(`<p id="scheme"></p><script>document.getElementById("scheme").textContent = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";</script>`),
  "/dialogs": () =>
    html(`<h1>Dialogs</h1><script>
      addEventListener("beforeunload", (e) => { e.preventDefault(); e.returnValue = "stay"; });
      onbeforeunload = () => "stay";
      document.body.setAttribute("onbeforeunload", "return 'stay'");
      setTimeout(() => alert("a timer alert"), 100);
      setTimeout(() => document.body.append(Object.assign(document.createElement("p"), { textContent: "Arrived late" })), 400);
    </script>`),
  "/hang": () => new Promise<Response>(() => {}),
  "/links": () =>
    html(`<h1>Links</h1><a href="/no-content">No content</a><a href="/download">Download</a>
      <a href="/locators" target="_blank">New tab</a>`),
  "/no-content": () => new Response(null, { status: 204 }),
  "/download": () =>
    new Response("downloaded", { headers: { "content-type": "text/plain", "content-disposition": 'attachment; filename="file.txt"' } }),
  // Only an element inside a shadow root moves; its host stays put.
  "/moving": () =>
    html(`<div id="host"></div><script>
      const spinner = Object.assign(document.createElement("div"), { id: "spinner" });
      spinner.style.cssText = "position:absolute;width:10px;height:10px;background:red";
      document.getElementById("host").attachShadow({ mode: "open" }).append(spinner);
      let x = 0;
      setInterval(() => (spinner.style.left = (x = (x + 1) % 100) + "px"), 20);
    </script>`),
  "/loading": () =>
    html(`<h1 id="state">Loading…</h1><script>fetch("/api/never").then(() => { document.getElementById("state").textContent = "Loaded"; });</script>`),
  "/iframe": () =>
    html(`<h1>With a frame</h1><button>Inside page</button><script>
      setTimeout(() => document.body.append(Object.assign(document.createElement("iframe"), { src: "${other}/frame" })), 100);
    </script>`),
  "/nav": () => html(`<a href="/rendered">Go to rendered</a>`),
  "/rendered": async () => {
    await Bun.sleep(150);
    return html(
      `<h1>Rendered page</h1><button class="target" onmouseenter="this.textContent = 'Hovered'">Hover me</button>`,
      `<link rel="stylesheet" href="/slow.css">`,
    );
  },
  "/slow.css": async () => {
    await Bun.sleep(300);
    return new Response(".target:hover { color: rgb(255, 0, 0); }", { headers: { "content-type": "text/css" } });
  },
  "/concurrent": () =>
    html(`<button onclick="this.dataset.clicked = 'yes'">Concurrent button</button><input placeholder="Concurrent field">`),
  "/cors": () =>
    html(`<h1>CORS</h1><pre id="out"></pre><script>
      const out = {};
      const attempt = (key, request) => request.then((r) => r.json()).then((v) => (out[key] = v), (e) => (out[key] = "failed: " + e.message));
      Promise.all([
        attempt("plain", fetch("${other}/api/plain")),
        attempt("credentialed", fetch("${other}/api/credentialed", { credentials: "include" })),
        attempt("preflighted", fetch("${other}/api/preflighted", { method: "PUT", headers: { "x-token": "1" } })),
        attempt("own", fetch("${other}/api/own")),
      ]).then(() => { document.getElementById("out").textContent = JSON.stringify(Object.fromEntries(Object.entries(out).sort())); });
    </script>`),
  "/outside": () =>
    html(
      `<h1>Outside</h1><img src="${other}/cross.png" width="10" height="10"><img src="/api/items" width="1" height="1">
      <pre id="out"></pre><script>
      const results = {};
      const ask = (key, url) => new Promise((resolve) => {
        const id = 100000 + Object.keys(results).length;
        const helpers = window.__vt;
        const answer = helpers.answerOutside;
        helpers.answerOutside = (answeredId, result) => {
          if (answeredId === id) { results[key] = "error" in result ? "refused" : "bytes"; resolve(); }
          else answer(answeredId, result);
        };
        window.__uiverifyOutsidePage(JSON.stringify({ id, url }));
      });
      window.addEventListener("load", async () => {
        await fetch("/api/secret", { mode: "no-cors" });
        await ask("loaded image", "${other}/cross.png");
        await ask("file", "file:///etc/hosts");
        await ask("metadata", "http://169.254.169.254/latest/meta-data/");
        await ask("never loaded", "${other}/red.png");
        await ask("json via img", "${app}/api/items");
        await ask("json via no-cors fetch", "${app}/api/secret");
        document.getElementById("out").textContent = JSON.stringify(results);
      });
      </script>`,
    ),
  "/error": () => html(`<h1>Error page</h1><script>throw new Error("the page broke");</script>`),
};

const otherPages: Record<string, () => Response> = {
  "/cross.png": () => new Response(asset("red.png"), { headers: { "content-type": "image/png" } }),
  "/redirect.png": () => Response.redirect(`http://127.0.0.1:${port + 1}/real.png`, 302),
  "/changing.png": () =>
    new Response(asset(++changing % 2 ? "red.png" : "blue.png"), {
      headers: { "content-type": "image/png", "cache-control": "no-store" },
    }),
  "/routed-once.png": () =>
    new Response(asset("red.png"), { headers: { "content-type": "image/png", "cache-control": "no-store" } }),
  "/earlier.png": () => new Response(asset("red.png"), { headers: { "content-type": "image/png" } }),
  "/real.png": () => new Response(asset("blue.png"), { headers: { "content-type": "image/png" } }),
  "/cross.css": () =>
    new Response(`@font-face { font-family: "Cross Fixture"; src: url(/cross-font.ttf) format("truetype"); }`, {
      headers: { "content-type": "text/css" },
    }),
  "/cross-font.ttf": () =>
    new Response(asset("cross-font.ttf"), { headers: { "content-type": "font/ttf", "access-control-allow-origin": "*" } }),
  "/frame": () => html(`<p>A cross-site frame</p>`),
  "/store": () =>
    html(`<p id="previous"></p><script>
      document.getElementById("previous").textContent = "previous: " + localStorage.getItem("key");
      localStorage.setItem("key", "set");
    </script>`),
};

Bun.serve({
  port,
  hostname: "127.0.0.1",
  fetch(request) {
    if (!ready) return new Response("not ready yet", { status: 503 });
    if (new URL(request.url).pathname === "/accept-language") return new Response(request.headers.get("accept-language") ?? "none");
    const page = pages[new URL(request.url).pathname];
    return page ? page() : new Response("not found", { status: 404 });
  },
});
Bun.serve({
  port: port + 1,
  fetch(request) {
    const page = otherPages[new URL(request.url).pathname];
    return page ? page() : new Response("not found", { status: 404 });
  },
});

console.log("fixture starting");
setTimeout(() => {
  ready = true;
  console.log(`fixture ready on ${app}`);
}, 800);
