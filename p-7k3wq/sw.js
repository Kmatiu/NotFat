/* Service worker del panel de plan personal.
   Hace que el plan se abra sin cobertura, que es la situación normal en el
   gimnasio y en muchos supermercados: cachea el HTML, la tipografía y todo lo
   que se haya visitado. Sube este archivo junto al index.html, en la misma
   carpeta.

   Es idéntico para todos los planes: se copia tal cual, sin tocar nada.
   Hereda las seis correcciones del service worker de las guías de viaje.

   ---------------------------------------------------------------------------
   Correcciones de esta versión, marcadas en el punto exacto donde estaban:
     1. addAll() es atómico: un solo 404 anulaba TODA la caché, en silencio.
     2. `caches.match(a) || caches.match(b)`: match() devuelve una promesa, y
        una promesa siempre es verdadera, así que la segunda nunca se evaluaba.
     3. respondWith() recibía undefined cuando no había ni red ni copia.
     4. El manejador de PRECACHE no llamaba a waitUntil: el navegador podía
        dormir el worker a mitad de la descarga.
     5. La precarga descartaba las respuestas opacas, justo las de otro dominio.
     6. El borrado de cachés antiguas se llevaba por delante la de la portada,
        porque el almacén de cachés es común a todo el dominio.
   --------------------------------------------------------------------------- */

var CACHE = 'plan-v1';
/* Solo se borran las cachés de planes, y además solo las de ESTE plan. El
   almacén de cachés es común a todo el dominio, no a esta carpeta: un
   `caches.keys()` devuelve también las de cualquier otra web publicada en el
   mismo sitio. Sin este prefijo, abrir un plan dejaba a los demás sin caché.
   Con varios usuarios en el mismo dominio esto no es una hipótesis. [FIX 6] */
var PREFIJO = 'plan-';
var CORE = ['./', './index.html'];
var CACHE_LIMIT = 120;

/* La tipografía vive en otro dominio: se guarda igual que lo demás y, si no
   está, el plan cae a la fuente del sistema sin romperse. */
function isFont(url) {
  return /fonts\.googleapis\.com|fonts\.gstatic\.com/.test(url);
}

/* Respuesta de cortesía para cuando no hay ni red ni copia guardada. Devolver
   undefined desde respondWith() provoca un error de red del navegador y llena
   la consola de avisos que tapan cualquier problema real. [FIX 3] */
function sinConexion(url) {
  var esNavegacion = /\.html?($|\?)/.test(url) || url.slice(-1) === '/';
  if (esNavegacion) {
    return new Response(
      '<!DOCTYPE html><meta charset="utf-8"><title>Sin conexión</title>' +
      '<body style="font-family:system-ui;display:grid;place-items:center;' +
      'height:100vh;margin:0;text-align:center;background:#111;color:#eee">' +
      '<div><h1>Sin conexión</h1><p>Esta parte del plan no está descargada. ' +
      'Con wifi, el botón «Preparar para el gimnasio» lo deja todo listo.</p></div>',
      { status: 504, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }
  return new Response('', { status: 504, statusText: 'Sin conexión' });
}

/* addAll() descarga todo y solo guarda si TODAS las respuestas son correctas:
   con que un archivo dé 404, se rechaza y no queda nada guardado. Como además
   el fallo se silenciaba, la guía parecía preparada y luego no abría sin
   cobertura. Aquí se cachea archivo a archivo, tolerando fallos sueltos. [FIX 1] */
function addAllTolerante(cache, urls) {
  return Promise.all(urls.map(function (u) {
    return cache.add(new Request(u, { cache: 'reload' })).catch(function () {
      return null;   // este archivo no está; el resto sigue guardándose
    });
  }));
}

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return addAllTolerante(c, CORE); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.map(function (k) {
          /* Solo las versiones antiguas de guías: lo demás no es asunto
             de este service worker. [FIX 6] */
          var esDeGuia = k.indexOf(PREFIJO) === 0;
          return (esDeGuia && k !== CACHE) ? caches.delete(k) : null;
        }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

/* Un plan es pequeño y no descarga mapas, así que la caché no crece sola. Este
   recorte existe por prudencia, para que años de versiones y tipografías no
   dejen el almacén lleno. */
function trimCache() {
  return caches.open(CACHE).then(function (c) {
    return c.keys().then(function (keys) {
      if (keys.length <= CACHE_LIMIT) return;
      return Promise.all(keys.slice(0, keys.length - CACHE_LIMIT).map(function (r) {
        return c.delete(r);
      }));
    });
  });
}

function putInCache(req, res) {
  if (!res) return res;
  /* Las respuestas opacas (otro dominio sin CORS, como la tipografía) no se pueden
     leer desde el código y su .ok es false, pero sí se pueden guardar y volver
     a servir. Por eso entran aquí igual que las normales. */
  if (!(res.ok || res.type === 'opaque')) return res;
  var copy = res.clone();
  caches.open(CACHE).then(function (c) {
    c.put(req, copy);
    if (isFont(req.url) && Math.random() < 0.05) trimCache();
  }).catch(function () {});
  return res;
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = req.url;
  if (url.indexOf('http') !== 0) return;   // salta chrome-extension:, data:, blob:

  /* La página: red primero para recoger el plan actualizado en cuanto se
     publique uno nuevo, y caché si no hay cobertura. Es lo que permite que al
     entregar la semana siguiente el usuario la vea sin hacer nada raro. */
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then(function (r) { return putInCache(req, r); })
        .catch(function () {
          return caches.match(req).then(function (m) {
            if (m) return m;

            /* Antes: `return caches.match('./index.html') || caches.match('./')`.
               match() devuelve una promesa y una promesa siempre es verdadera,
               así que el `||` se quedaba con la primera y la segunda opción no
               llegaba a evaluarse. Si index.html no estaba guardado pero './'
               sí, esto resolvía a undefined y el navegador mostraba su pantalla
               de error en lugar del plan. [FIX 2] */
            return caches.match('./index.html')
              .then(function (p) { return p || caches.match('./'); })
              .then(function (p) { return p || sinConexion(url); });
          });
        })
    );
    return;
  }

  /* Tipografía y demás recursos: caché primero, que es lo que da la sensación
     de instantáneo al abrir un plan ya preparado. */
  e.respondWith(
    caches.match(req).then(function (m) {
      if (m) return m;
      return fetch(req)
        .then(function (r) { return putInCache(req, r); })
        /* Aquí `m` ya se sabe que es undefined: si tuviera valor se habría
           devuelto arriba. Devolverlo dejaba a respondWith sin Response. [FIX 3] */
        .catch(function () { return sinConexion(url); });
    })
  );
});

/* La guía puede pedir que se precarguen archivos concretos: es lo que hace el
   botón «Preparar para usar sin conexión». */
self.addEventListener('message', function (e) {
  var data = e.data || {};

  if (data.type === 'PRECACHE' && Array.isArray(data.urls)) {
    var port = e.ports && e.ports[0];

    /* Sin waitUntil, el navegador da por terminado el trabajo en cuanto vuelve
       del manejador y puede dormir el worker a mitad de la descarga: la barra
       se queda parada, sin error, y faltan archivos. [FIX 4] */
    e.waitUntil(
      caches.open(CACHE).then(function (c) {
        var done = 0;
        var total = data.urls.length;
        var fallidas = [];

        return Promise.all(data.urls.map(function (u) {
          return fetch(new Request(u, { cache: 'reload' }))
            .then(function (r) {
              /* Antes solo se aceptaba r.ok, y una respuesta opaca tiene
                 ok === false: lo servido desde otro dominio se descartaba justo
                 en la precarga, que es donde más falta hacía guardarlo. Además
                 el criterio era incoherente con putInCache, que sí lo aceptaba,
                 de modo que un archivo visto navegando se guardaba y el mismo
                 archivo pedido por la precarga, no. [FIX 5] */
              if (r && (r.ok || r.type === 'opaque')) return c.put(u, r);
              fallidas.push(u);
            })
            .catch(function () { fallidas.push(u); })
            .then(function () {
              done++;
              if (port) port.postMessage({ done: done, total: total });
            });
        })).then(function () {
          /* `done: total` cierra la barra de progreso al 100 %. Y se informa de
             lo que no se pudo guardar, por si la interfaz quiere usarlo.
             Aquí, a diferencia de las guías, todas las URL pedidas deberían
             existir: un fallo sí significa algo y conviene volver a intentarlo
             con wifi. */
          if (port) port.postMessage({
            finished: true,
            done: total,
            total: total,
            failed: fallidas.length,
            failedUrls: fallidas
          });
        });
      }).catch(function (err) {
        if (port) port.postMessage({ finished: true, error: String(err) });
      })
    );
    return;
  }

  /* Permite que el panel pregunte cuánto hay ya descargado y muestre «ya
     preparado» sin volver a bajarlo todo. La interfaz actual no lo usa. */
  if (data.type === 'STATUS' && Array.isArray(data.urls)) {
    var portS = e.ports && e.ports[0];
    e.waitUntil(
      caches.open(CACHE).then(function (c) {
        var guardadas = 0;
        return Promise.all(data.urls.map(function (u) {
          return c.match(u).then(function (m) { if (m) guardadas++; });
        })).then(function () {
          if (portS) portS.postMessage({ cached: guardadas, total: data.urls.length });
        });
      })
    );
    return;
  }

  if (data.type === 'CLEAR') {
    var portC = e.ports && e.ports[0];
    e.waitUntil(
      caches.delete(CACHE).then(function () {
        if (portC) portC.postMessage({ cleared: true });
      })
    );
  }
});
