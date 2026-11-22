const C="dt-v1";
self.addEventListener("install",e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(["./","index.html","manifest.webmanifest","icon-192.png","icon-512.png"])));self.skipWaiting()});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))).then(()=>self.clients.claim()))});
// Réseau d'abord (pour recevoir les mises à jour), cache si hors ligne. L'API et PayPal ne sont jamais mis en cache.
self.addEventListener("fetch",e=>{const u=new URL(e.request.url);if(e.request.method!=="GET"||u.origin!==location.origin||u.pathname.startsWith("/api/")||u.pathname.startsWith("/paypal/"))return;
e.respondWith(fetch(e.request).then(r=>{const cp=r.clone();caches.open(C).then(c=>c.put(e.request,cp));return r}).catch(()=>caches.match(e.request).then(m=>m||caches.match("index.html"))))});
