self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);
    if (event.request.mode !== 'navigate' || url.origin !== self.location.origin || url.pathname !== '/explorer') return;
    event.respondWith(fetch(event.request).catch(() => new Response(
        '<!doctype html><html lang="es"><meta charset="utf-8"><title>Explorer sin conexión</title><h1>Explorer sin conexión</h1><p>Verificá que el servidor esté iniciado y <a href="/explorer">volvé a intentar</a>.</p></html>',
        {status:503,headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}}
    )));
});
