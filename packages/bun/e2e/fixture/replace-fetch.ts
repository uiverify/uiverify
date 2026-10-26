globalThis.fetch = Object.assign(async () => new Response("replaced"), { preconnect: () => {} });
