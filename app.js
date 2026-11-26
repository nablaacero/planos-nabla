/* Avance NABLA - extensión del visor 3D de Trimble Connect */
(function () {
  "use strict";
  var C = window.CONFIG, L = window.Logica;
  var API = null;
  var tornillos = [];         // pernos / tuercas / arandelas del modelo
  var indicePiezas = {}, infoMarca = null, fechaRevision = null;
  var indice = null;          // { marca: [ {modelId, id} ] }  (una entrada por pieza física / ensamble)
  var filas = null;           // avance leído
  var ultimo = null;          // resultado del último coloreado
  var temporizador = null, ultimoArchivo = "", fechaAvance = null;
  var tokTC = null, esperaTok = null, baseTC = null, todosIds = [];
  var $ = function (id) { return document.getElementById(id); };
  var pzDe = {}, pesoDe = {};   // objeto del modelo -> marca de pieza / peso

  // Vista "Ensamble + piezas": cada pieza combina el estado del plano de su ensamble y el de su propio plano
  var COMB = [
    { nombre: "No está en la revisión",                 color: "#BDBDBD" },
    { nombre: "Falta plano de ensamble y de habilitado", color: "#D93025" },
    { nombre: "Por revisar / falta NC",                 color: "#F28C28" },
    { nombre: "Con plano de ensamble · falta plano de habilitado", color: "#8E44AD" },
    { nombre: "Con plano de habilitado · falta plano de ensamble", color: "#F2C500" },
    { nombre: "Con plano de ensamble y de habilitado", color: "#2EAA4A" }
  ];
  function categoria(E, P) {
    if (!E && !P) return 0;
    if (!P) P = E; if (!E) E = P === 3 ? 1 : P;      // sin dato de uno: se toma el del otro
    if (E === 2 || P === 2) return 2;
    if (E === 3 && P === 3) return 5;
    if (E === 3) return 3;
    if (P === 3) return 4;
    return 1;
  }

  function estado(txt, error) {
    var e = $("estado"); if (!e) return; e.textContent = txt || ""; e.className = error ? "error" : "";
  }
  function ocupado(si) { if (!$("btnColorear")) return; $("btnColorear").disabled = si; $("btnReset").disabled = si; }

  // ------------------------------------------------------------ conexión con Trimble Connect
  async function conectar() {
    try {
      API = await TrimbleConnectWorkspace.connect(window.parent, function (evento, datos) {
        if (evento === "viewer.onModelStateChanged" || evento === "viewer.onModelReset") indice = null;
        if (evento === "extension.accessToken") {
          var t = datos && datos.data !== undefined ? datos.data : datos;
          if (t && t !== "pending" && t !== "denied") { tokTC = t; if (esperaTok) { esperaTok(t); esperaTok = null; } }
        }
      }, 30000);
      try {
        var p = await API.project.getProject();
        var m = (p && p.name || "").match(new RegExp(C.patronProyecto));
        var guardado = leerLocal("proyecto:" + (p && p.id));
        $("proyecto").value = guardado || (m ? m[1] : "");
        $("proyecto").dataset.pid = p && p.id || "";
        var ord = leerLocal("orden:" + (p && p.id));
        if (ord) $("orden").value = ord;
      } catch (e) { /* sin proyecto */ }
      estado("Listo. Carga los modelos y presiona «Colorear planos».");
      if ((C.gruposBloqueados || []).length) verificarAcceso().catch(function () {});
    } catch (e) {
      estado("No se pudo conectar con Trimble Connect. Abre esta página desde el visor 3D.", true);
    }
  }

  function leerLocal(k) { try { return localStorage.getItem("plnabla:" + k); } catch (e) { return null; } }
  function guardarLocal(k, v) { try { localStorage.setItem("plnabla:" + k, v); } catch (e) {} }

  // ------------------------------------------------------------ índice marca -> piezas del modelo
  async function indexar() {
    estado("Leyendo propiedades de los modelos cargados…");
    var modelos = await API.viewer.getObjects();
    todosIds = modelos.map(function (m) { return { modelId: m.modelId, objectRuntimeIds: (m.objects || []).map(function (o) { return o.id; }) }; });
    var asm = {}, partes = {}, asmSin = [], marcaPieza = {}, pesoObj = {};
    var total = 0; tornillos = []; var pzIdx = {}; pzDe = {}; pesoDe = pesoObj;
    for (var a = 0; a < modelos.length; a++) {
      var mid = modelos[a].modelId;
      var ids = (modelos[a].objects || []).map(function (o) { return o.id; });
      for (var i = 0; i < ids.length; i += 1000) {
        var lote = ids.slice(i, i + 1000);
        var props = await API.viewer.getObjectProperties(mid, lote);
        props.forEach(function (o) {
          if (esTornillo(o)) { tornillos.push({ modelId: mid, id: o.id }); return; }
          var pw = L.pesoDeObjeto(o, C.propiedadesPeso || []);
          if (pw) pesoObj[mid + ":" + o.id] = pw;
          if (String(o.class || "").toUpperCase().indexOf("ASSEMBLY") < 0) {
            var pz = L.marcaDeObjeto(o, C.propiedadesPieza || []);
            if (pz) { (pzIdx[pz] = pzIdx[pz] || []).push({ modelId: mid, id: o.id, peso: pw || 0 }); pzDe[mid + ":" + o.id] = pz; }
          }
          var marca = L.marcaDeObjeto(o, C.propiedadesMarca);
          var esAsm = String(o.class || "").toUpperCase().indexOf("ASSEMBLY") >= 0;
          if (!marca) { if (esAsm) asmSin.push({ modelId: mid, id: o.id }); return; }
          if (esAsm) (asm[marca] = asm[marca] || []).push({ modelId: mid, id: o.id });
          else { (partes[marca] = partes[marca] || []).push({ modelId: mid, id: o.id }); marcaPieza[mid + ":" + o.id] = marca; }
        });
        total += lote.length;
        estado("Leyendo propiedades… " + total + " objetos");
      }
    }
    // ensambles sin marca propia (ej. Advance Steel): la marca se toma de sus piezas
    var cubiertas = {};
    for (var u = 0; u < asmSin.length; u += 40) {
      var lote0 = asmSin.slice(u, u + 40);
      var hh = await Promise.all(lote0.map(async function (x) {
        try { return await API.viewer.getHierarchyChildren(x.modelId, [x.id], 4, true); } catch (e) { return []; }
      }));
      lote0.forEach(function (x, j) {
        var ids = (hh[j] || []).map(function (e) { return e.id; });
        var m = null;
        for (var q = 0; q < ids.length && !m; q++) m = marcaPieza[x.modelId + ":" + ids[q]];
        if (!m) return;
        ids.forEach(function (i) { cubiertas[x.modelId + ":" + i] = 1; });
        (asm[m] = asm[m] || []).push({ modelId: x.modelId, id: x.id, hijos: ids });
      });
      estado("Leyendo ensambles… " + Math.min(u + 40, asmSin.length) + "/" + asmSin.length);
    }
    Object.keys(partes).forEach(function (m) {
      partes[m] = partes[m].filter(function (x) { return !cubiertas[x.modelId + ":" + x.id]; });
      if (!partes[m].length) delete partes[m];
    });
    // marcas con objeto ensamble: cada ensamble es una pieza física (se colorea con sus hijos)
    var idx = {};
    var listaAsm = [];
    Object.keys(asm).forEach(function (m) {
      asm[m].forEach(function (x) {
        if (x.hijos) (idx[m] = idx[m] || []).push({ modelId: x.modelId, ids: [x.id].concat(x.hijos), asm: true });
        else listaAsm.push({ m: m, x: x });
      });
    });
    for (var t = 0; t < listaAsm.length; t += 40) {
      var lote1 = listaAsm.slice(t, t + 40);
      var hijos = await Promise.all(lote1.map(async function (it) {
        try {
          var h = await API.viewer.getHierarchyChildren(it.x.modelId, [it.x.id], 4, true);
          return (h || []).map(function (e) { return e.id; });
        } catch (e) { return null; }
      }));
      lote1.forEach(function (it, j) {
        var inst = hijos[j] && hijos[j].length
          ? { modelId: it.x.modelId, ids: [it.x.id].concat(hijos[j]), asm: true }
          : { modelId: it.x.modelId, id: it.x.id, rec: true, asm: true };
        (idx[it.m] = idx[it.m] || []).push(inst);
      });
      estado("Agrupando piezas por ensamble… " + Math.min(t + 40, listaAsm.length) + "/" + listaAsm.length);
    }
    // marcas que solo aparecen en las piezas: agrupar por ensamble padre
    var soloPartes = Object.keys(partes).filter(function (m) { return !idx[m]; });
    for (var s = 0; s < soloPartes.length; s++) {
      var m = soloPartes[s], grupos = {};
      for (var k = 0; k < partes[m].length; k += 40) {
        var lote2 = partes[m].slice(k, k + 40);
        var claves = await Promise.all(lote2.map(async function (x) {
          try {
            var padres = await API.viewer.getHierarchyParents(x.modelId, [x.id], 4, false);
            if (padres && padres.length) return x.modelId + ":P" + padres[0].id;
          } catch (e) {}
          return x.modelId + ":" + x.id;
        }));
        lote2.forEach(function (x, j) {
          (grupos[claves[j]] = grupos[claves[j]] || { modelId: x.modelId, ids: [] }).ids.push(x.id);
        });
      }
      if (s % 20 === 0) estado("Agrupando piezas por ensamble… " + (s + 1) + "/" + soloPartes.length);
      idx[m] = Object.keys(grupos).map(function (g) { return { modelId: grupos[g].modelId, ids: grupos[g].ids }; });
    }
    // peso de cada pieza física: el del ensamble; si no lo trae, la suma de sus piezas
    Object.keys(idx).forEach(function (m) {
      idx[m].forEach(function (inst) {
        var ids = inst.ids || [inst.id];
        var w = inst.asm ? (pesoObj[inst.modelId + ":" + ids[0]] || 0) : 0;
        if (!w) for (var i = (inst.asm ? 1 : 0); i < ids.length; i++) w += pesoObj[inst.modelId + ":" + ids[i]] || 0;
        if (!w && inst.id) w = pesoObj[inst.modelId + ":" + inst.id] || 0;
        inst.peso = w;
      });
    });
    // posición (centro de la caja envolvente) de cada pieza física, para ordenar el avance por dirección
    try {
      var porModelo = {};
      Object.keys(idx).forEach(function (m) {
        idx[m].forEach(function (inst) {
          (porModelo[inst.modelId] = porModelo[inst.modelId] || []).push.apply(porModelo[inst.modelId], inst.ids || [inst.id]);
        });
      });
      var centro = {};
      var mods = Object.keys(porModelo);
      for (var mm = 0; mm < mods.length; mm++) {
        var lista = porModelo[mods[mm]];
        for (var b = 0; b < lista.length; b += 1000) {
          var cajas = await API.viewer.getObjectBoundingBoxes(mods[mm], lista.slice(b, b + 1000));
          (cajas || []).forEach(function (c) {
            var bx = c.boundingBox;
            if (!bx || !bx.min || !bx.max || !isFinite(bx.min.x) || !isFinite(bx.max.x)) return;
            centro[mods[mm] + ":" + c.id] = [(bx.min.x + bx.max.x) / 2, (bx.min.y + bx.max.y) / 2, (bx.min.z + bx.max.z) / 2];
          });
          estado("Leyendo posiciones… " + Math.min(b + 1000, lista.length) + "/" + lista.length);
        }
      }
      Object.keys(idx).forEach(function (m) {
        idx[m].forEach(function (inst) {
          var s = [0, 0, 0], n = 0;
          (inst.ids || [inst.id]).forEach(function (id) {
            var c = centro[inst.modelId + ":" + id];
            if (c) { s[0] += c[0]; s[1] += c[1]; s[2] += c[2]; n++; }
          });
          inst.c = n ? [s[0] / n, s[1] / n, s[2] / n] : null;
        });
      });
    } catch (e) { /* sin posiciones: se usa el orden interno */ }
    indice = idx;
    indicePiezas = pzIdx;
    return idx;
  }

  // ------------------------------------------------------------ lectura del avance
  var msalApp = null;
  async function tokenGraph() {
    if (!C.clientId) throw new Error("Falta el clientId de Entra ID en config.js (lo da TI). Mientras tanto usa el modo CSV.");
    if (!msalApp) {
      msalApp = new msal.PublicClientApplication({
        auth: { clientId: C.clientId, authority: "https://login.microsoftonline.com/" + C.tenantId, redirectUri: C.redirectUri },
        cache: { cacheLocation: "localStorage" }
      });
      if (msalApp.initialize) await msalApp.initialize();
    }
    var pet = { scopes: ["Sites.Read.All"] };
    var cuentas = msalApp.getAllAccounts();
    if (cuentas.length) {
      try { return (await msalApp.acquireTokenSilent(Object.assign({ account: cuentas[0] }, pet))).accessToken; } catch (e) {}
    }
    return (await msalApp.acquireTokenPopup(pet)).accessToken;
  }

  async function leerSharePoint() {
    estado("Leyendo la lista de SharePoint…");
    var tk = await tokenGraph();
    var h = { Authorization: "Bearer " + tk };
    var r = await fetch("https://graph.microsoft.com/v1.0/sites/" + C.sharepointHost + ":" + C.sitePath, { headers: h });
    if (!r.ok) throw new Error("No se pudo abrir el sitio de SharePoint (" + r.status + ").");
    var sitio = await r.json();
    var f = C.campos;
    var url = "https://graph.microsoft.com/v1.0/sites/" + sitio.id + "/lists/" + encodeURIComponent(C.listName) +
      "/items?$top=999&$expand=fields($select=" + [f.marca, f.proyecto, f.etapa, f.cantidad, "Created"].join(",") + ")";
    var out = [], maxF = 0;
    while (url) {
      var rr = await fetch(url, { headers: h });
      if (!rr.ok) throw new Error("No se pudo leer la lista (" + rr.status + ").");
      var j = await rr.json();
      (j.value || []).forEach(function (it) {
        var x = it.fields || {};
        out.push({ marca: x[f.marca], proyecto: x[f.proyecto], etapa: x[f.etapa], cantidad: x[f.cantidad] });
        var tf = Date.parse(x.Created || it.createdDateTime || 0); if (tf > maxF) maxF = tf;
      });
      url = j["@odata.nextLink"];
    }
    ultimoArchivo = "lista de SharePoint (último reporte)";
    fechaAvance = maxF ? new Date(maxF) : null;
    return out;
  }

  // ---------- archivo dentro del proyecto de Trimble Connect
  async function tokenTC() {
    if (tokTC) return tokTC;
    var t = await API.extension.requestPermission("accesstoken");
    if (t && t !== "pending" && t !== "denied") { tokTC = t; return t; }
    if (t === "denied") throw new Error("Trimble Connect no dio permiso a la extensión. Acepta el acceso e inténtalo de nuevo.");
    estado("Acepta el permiso que muestra Trimble Connect…");
    return await new Promise(function (ok, mal) {
      esperaTok = ok;
      setTimeout(function () { mal(new Error("Acepta el permiso de acceso de Trimble Connect y vuelve a presionar «Colorear avance».")); }, 90000);
    });
  }

  async function tc(ruta, tk) {
    var r = await fetch(baseTC + ruta, { headers: { Authorization: "Bearer " + tk } });
    if (r.status === 401) { tokTC = null; throw new Error("La sesión de Trimble Connect venció; vuelve a presionar «Colorear avance»."); }
    if (!r.ok) throw new Error("Trimble Connect respondió " + r.status + " en " + ruta);
    return r.json();
  }

  // encuentra la región del proyecto (una sola vez) y devuelve los datos del proyecto
  async function asegurarBase(tk, pid) {
    if (baseTC) return await tc("/projects/" + pid, tk);
    var info = null;
    var bases = ["https://app.connect.trimble.com", "https://app21.connect.trimble.com", "https://app22.connect.trimble.com",
                 "https://app31.connect.trimble.com", "https://app32.connect.trimble.com"];
    for (var b = 0; b < bases.length && !info; b++) {
      try {
        var rr = await fetch(bases[b] + "/tc/api/2.0/projects/" + pid, { headers: { Authorization: "Bearer " + tk } });
        if (rr.ok) { info = await rr.json(); baseTC = bases[b] + "/tc/api/2.0"; }
      } catch (e) {}
    }
    if (!info) throw new Error("No pude abrir el proyecto con la API de Trimble Connect.");
    return info;
  }

  // ---------- control de acceso por grupo del proyecto (ej. EXTERNO)
  var acceso = null, diagAcceso = "";
  function lista(x) { return Array.isArray(x) ? x : (x && (x.items || x.data || x.users || x.members)) || []; }
  async function intentar(tk, rutas) {
    for (var i = 0; i < rutas.length; i++) {
      try {
        var r = await fetch(baseTC + rutas[i], { headers: { Authorization: "Bearer " + tk } });
        if (r.ok) { diagAcceso += "\n  OK " + rutas[i]; return await r.json(); }
        diagAcceso += "\n  " + r.status + " " + rutas[i];
      } catch (e) { diagAcceso += "\n  error " + rutas[i]; }
    }
    return null;
  }
  async function verificarAcceso() {
    var bloq = (C.gruposBloqueados || []).map(norm);
    if (!bloq.length || acceso === true) return;
    if (acceso === false) throw new Error("Sin acceso");
    diagAcceso = "Control de acceso (grupos bloqueados: " + C.gruposBloqueados.join(", ") + ")";
    var tk, proy;
    try { tk = await tokenTC(); proy = await API.project.getProject(); await asegurarBase(tk, proy.id); }
    catch (e) { diagAcceso += "\n  → no se pudo verificar (" + (e.message || e) + "); se permite el acceso"; acceso = true; return; }
    var yo = await intentar(tk, ["/users/me"]);
    var grupos = lista(await intentar(tk, ["/groups?projectId=" + proy.id, "/projects/" + proy.id + "/groups"]));
    if (!yo || !grupos.length) { diagAcceso += "\n  → no se pudo verificar; se permite el acceso"; acceso = true; return; }
    var miIds = [yo.id, yo.tiduuid, yo.uuid].filter(Boolean), miMail = String(yo.email || "").toLowerCase();
    var esMiembro = function (u) {
      return miIds.indexOf(u.id) >= 0 || miIds.indexOf(u.tiduuid) >= 0 || miIds.indexOf(u.userId) >= 0 ||
        (miMail && String(u.email || "").toLowerCase() === miMail);
    };
    acceso = true;
    for (var g = 0; g < grupos.length && acceso; g++) {
      if (bloq.indexOf(norm(grupos[g].name)) < 0) continue;
      var miembros = lista(grupos[g].users || grupos[g].members);
      if (!miembros.length) miembros = lista(await intentar(tk, ["/groups/" + grupos[g].id + "/users", "/groups/" + grupos[g].id + "/members"]));
      diagAcceso += "\n  grupo " + grupos[g].name + ": " + miembros.length + " miembros";
      if (miembros.some(esMiembro)) acceso = false;
    }
    diagAcceso += "\n  → " + (acceso ? "acceso permitido" : "acceso BLOQUEADO");
    if (!acceso) {
      document.body.innerHTML = '<div style="font-family:Segoe UI,Arial,sans-serif;padding:24px;color:#14325f">' +
        '<h3 style="margin:0 0 8px">Avance de producción</h3>' +
        '<p style="font-size:13px;color:#4b5563">Esta herramienta es de uso interno de NABLA Acero y no está disponible para tu usuario.</p></div>';
      throw new Error("Sin acceso");
    }
  }

  async function leerTrimble() {
    estado("Buscando la revisión de planos en " + C.carpetaRevision + "…");
    var tk = await tokenTC();
    var proy = await API.project.getProject();
    var info = null;
    if (!baseTC) {
      var bases = ["https://app.connect.trimble.com", "https://app21.connect.trimble.com", "https://app22.connect.trimble.com",
                   "https://app31.connect.trimble.com", "https://app32.connect.trimble.com"];
      for (var b = 0; b < bases.length && !info; b++) {
        try {
          var rr = await fetch(bases[b] + "/tc/api/2.0/projects/" + proy.id, { headers: { Authorization: "Bearer " + tk } });
          if (rr.ok) { info = await rr.json(); baseTC = bases[b] + "/tc/api/2.0"; }
        } catch (e) {}
      }
      if (!info) throw new Error("No pude abrir el proyecto con la API de Trimble Connect.");
    } else info = await tc("/projects/" + proy.id, tk);
    var carpeta = info.rootId;
    var partes = C.carpetaRevision.split("/").filter(Boolean);
    for (var i = 0; i < partes.length; i++) {
      var items = await tc("/folders/" + carpeta + "/items", tk);
      var f = (items || []).filter(function (x) {
        return String(x.type).toUpperCase() === "FOLDER" && norm(x.name) === norm(partes[i]);
      })[0];
      if (!f) throw new Error("No encontré la carpeta «" + partes[i] + "» en Trimble Connect.");
      carpeta = f.id;
    }
    var arch = (await tc("/folders/" + carpeta + "/items", tk) || []).filter(function (x) {
      return String(x.type).toUpperCase() === "FILE" && /\.(xlsx|xlsm|xls)$/i.test(x.name || "") &&
        new RegExp(C.patronArchivo, "i").test(norm(x.name));
    });
    if (!arch.length) throw new Error("En " + C.carpetaRevision + " no hay ningún Excel de revisión de planos (nombre tipo «1274_Revision_Planos_PDF.xlsm»).");
    var fecha = function (x) { return Date.parse(x.modifiedOn || x.modified || x.createdOn || 0) || 0; };
    arch.sort(function (x, y) { return fecha(y) - fecha(x); });
    var a = arch[0];
    estado("Leyendo " + a.name + "…");
    var du = await tc("/files/fs/" + a.id + "/downloadurl", tk);
    var url = du.url || du.downloadUrl || du;
    var resp = await fetch(url);
    if (!resp.ok) throw new Error("No se pudo descargar " + a.name + " (" + resp.status + ").");
    var buf = await resp.arrayBuffer();
    var filas = convertir(buf, a.name);
    ultimoArchivo = a.name;
    fechaAvance = fecha(a) ? new Date(fecha(a)) : null;
    return filas;
  }

  function norm(t) { return String(t || "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""); }

  // contenido (ArrayBuffer) de un .csv o .xlsx -> filas de avance
  function convertir(buf, nombre) {
    var wb = XLSX.read(new Uint8Array(buf), { type: "array", cellDates: true });
    var hojas = wb.SheetNames.slice().sort(function (x, y) { return (norm(y) === norm(C.hojaResultado)) - (norm(x) === norm(C.hojaResultado)); });
    for (var s = 0; s < hojas.length; s++) {
      var m = XLSX.utils.sheet_to_json(wb.Sheets[hojas[s]], { header: 1, raw: true, defval: "" });
      var filas = leerRevision(m);
      if (filas) return filas;
    }
    throw new Error("No encontré la hoja «" + C.hojaResultado + "» con columnas Tipo, Marca y Resultado en " + nombre + ".");
  }

  // hoja Resultado -> [{tipo, marca, resultado, plano, fecha, obs}]
  function leerRevision(m) {
    var h = -1, col = {};
    for (var i = 0; i < Math.min(m.length, 60) && h < 0; i++) {
      var fila = m[i].map(function (v) { return norm(v); });
      if (fila.indexOf("marca") >= 0 && fila.indexOf("resultado") >= 0 && fila.indexOf("tipo") >= 0) {
        h = i;
        fila.forEach(function (v, j) {
          if (v === "tipo") col.tipo = j; else if (v === "marca") col.marca = j; else if (v === "resultado") col.res = j;
          else if (/^plano/.test(v)) col.plano = j; else if (/^fecha/.test(v)) col.fecha = j;
          else if (/^observ/.test(v)) col.obs = j; else if (/^descrip/.test(v)) col.desc = j;
        });
      }
    }
    if (h < 0) return null;
    // fecha de la revisión: celda "Revisado dd/mm/aa hh:mm" del encabezado
    fechaRevision = null;
    for (var k = 0; k < h && !fechaRevision; k++) m[k].forEach(function (v) {
      var x = String(v).match(/revisado\s+(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{2}))?/i);
      if (x && !fechaRevision) {
        var an = +x[3]; if (an < 100) an += 2000;
        fechaRevision = new Date(an, +x[2] - 1, +x[1], +(x[4] || 0), +(x[5] || 0));
      }
    });
    var out = [];
    for (var f = h + 1; f < m.length; f++) {
      var r = m[f], marca = L.normalizarMarca(r[col.marca]);
      if (!marca || !r[col.tipo]) continue;
      out.push({ tipo: String(r[col.tipo]).trim().toUpperCase(), marca: marca, resultado: String(r[col.res] || "").trim().toUpperCase(),
        plano: col.plano !== undefined ? r[col.plano] : "", fecha: col.fecha !== undefined ? r[col.fecha] : "",
        obs: col.obs !== undefined ? String(r[col.obs] || "") : "", desc: col.desc !== undefined ? String(r[col.desc] || "") : "" });
    }
    return out;
  }

  // filas del Excel -> { marca: [0,0,N] } en el formato que usa repartir(), según la vista
  function estadosDe(filas, vista) {
    var sumas = {}, info = {}, n = C.etapas.length;
    // Filas de sub-ensambles ("ENSAMBLE SUB" / "PIEZA SUB"): solo se usan si la marca no está en el listado general
    var esSub = function (x) { return /\bSUB\b/.test(x.tipo); };
    var general = {};
    filas.forEach(function (x) { if (!esSub(x)) String(x.marca).split("/").forEach(function (t) { general[L.normalizarMarca(t)] = 1; }); });
    filas = filas.filter(function (x) { return !esSub(x) || !general[x.marca]; });
    filas.forEach(function (x0) {
      var x = x0;
      var esEns = /^ENSAMBLE/.test(x.tipo), esPz = /^PIEZA/.test(x.tipo);
      // "MARCA ÚNICA": ensamble de una sola pieza, ej. "P6008 / U21" (ensamble P6008 = pieza U21)
      if (/^MARCA\s*UNICA|^MARCA\s*ÚNICA/.test(x.tipo)) {
        var dos = String(x.marca).split("/").map(function (t) { return L.normalizarMarca(t); }).filter(Boolean);
        x = Object.assign({}, x, { marca: vista === "piezas" ? (dos[1] || dos[0]) : dos[0] });
        esEns = esPz = true;
      }
      if (vista === "piezas" ? !esPz : !esEns) return;
      var e = 0;
      for (var i = 0; i < C.resultados.length && !e; i++) if (new RegExp(C.resultados[i].patron, "i").test(x.resultado)) e = C.resultados[i].estado;
      // pieza de sub-ensamble: vale el plano del sub-ensamble
      if (!e && /^SUB-ENSAMBLE/.test(x.resultado) && /con plano/i.test(x.obs)) e = n;
      if (!e) return;
      if (info[x.marca] && info[x.marca].e <= e) return;    // si se repite, vale el peor estado
      info[x.marca] = { e: e, res: x.resultado, plano: x.plano, fecha: x.fecha, desc: x.desc };
      var s = []; for (var j = 0; j < n; j++) s.push(j === e - 1 ? 1e9 : 0);
      sumas[x.marca] = s;
    });
    infoMarca = info;
    return sumas;
  }

  function leerArchivo() {
    return new Promise(function (ok, mal) {
      var fi = $("archivo").files[0];
      if (!fi) return mal(new Error("Elige el archivo CSV exportado de la lista."));
      var rd = new FileReader();
      rd.onload = function () {
        try { ultimoArchivo = fi.name; fechaAvance = fi.lastModified ? new Date(fi.lastModified) : null; ok(convertir(rd.result, fi.name)); }
        catch (e) { mal(e); }
      };
      rd.onerror = function () { mal(new Error("No se pudo leer el archivo.")); };
      rd.readAsArrayBuffer(fi);
    });
  }

  // ------------------------------------------------------------ coloreado
  function selector(lista) {
    var porModelo = {};
    lista.forEach(function (x) {
      var k = x.modelId + (x.rec ? "|r" : "");
      var g = porModelo[k] = porModelo[k] || { modelId: x.modelId, objectRuntimeIds: [], recursive: !!x.rec };
      if (x.ids) Array.prototype.push.apply(g.objectRuntimeIds, x.ids); else g.objectRuntimeIds.push(x.id);
    });
    return { modelObjectIds: Object.keys(porModelo).map(function (k) { return porModelo[k]; }) };
  }

  function prefijo(m) { var x = String(m).match(/([A-Z]+)\d+[A-Z]?$/); return x ? x[1] : ""; }
  // filtro de secundarios: "todo" | "sin" (ocultarlos) | "solo" (ver solo ellos)
  function modoSec() { return $("filtroSec").value; }
  function esSec(m) { return (C.prefijosOcultables || []).indexOf(prefijo(m)) >= 0; }
  function oculta(m) { var f = modoSec(); return f === "sin" ? esSec(m) : f === "solo" ? !esSec(m) : false; }
  async function aplicarFiltro() {
    if (!ultimo) return;
    if (ultimo.modo === "solo" && ultimo.visibles.length) {
      // igual que "Mostrar solo los seleccionados" del visor
      var sel = selector(ultimo.visibles), ok = false;
      try {
        ok = await API.viewer.isolateEntities(sel.modelObjectIds.map(function (g) {
          return { modelId: g.modelId, entityIds: g.objectRuntimeIds };
        }));
      } catch (e) { ok = false; }
      if (ok === false) {
        // respaldo: ocultar explícitamente todo lo que no es secundario
        var ver = {};
        sel.modelObjectIds.forEach(function (g) { g.objectRuntimeIds.forEach(function (id) { ver[g.modelId + ":" + id] = 1; }); });
        var ocultar = todosIds.map(function (g) {
          return { modelId: g.modelId, objectRuntimeIds: g.objectRuntimeIds.filter(function (id) { return !ver[g.modelId + ":" + id]; }) };
        }).filter(function (g) { return g.objectRuntimeIds.length; });
        if (ocultar.length) await API.viewer.setObjectState({ modelObjectIds: ocultar }, { visible: false });
      }
    }
    if (ultimo.ocultas.length) await API.viewer.setObjectState(selector(ultimo.ocultas), { visible: false });
  }
  function textoFiltro() {
    return ultimo && ultimo.modo === "sin" ? " (est. principal, sin " + textoOcultables() + ")"
      : ultimo && ultimo.modo === "solo" ? " (solo " + (C.prefijosOcultables || []).join(", ") + ")" : "";
  }
  // tornillos: clase IFC de fijación, o accesorio cuyo nombre/descripción indique perno
  function esTornillo(o) {
    var cl = String(o.class || "").toUpperCase();
    if (/FASTENER/.test(cl)) return true;
    if (!/ACCESSORY|PROXY/.test(cl)) return false;
    var t = ((o.product && (o.product.name + " " + (o.product.description || ""))) || "") + " " + (o.name || "");
    return /\b(bolt|perno|tornillo|tuerca|arandela|nut|washer|anchor)/i.test(t);
  }
  function textoOcultables() {
    var p = (C.prefijosOcultables || []).slice();
    if (C.ocultarTornillos !== false) p.push("tornillos");
    return p.join(", ");
  }

  // Orden en que se asigna el avance dentro de una misma marca (lo más avanzado va primero).
  // Se agrupa cada 0.5 m en el eje principal para que piezas alineadas se ordenen por el secundario.
  function comparadorOrden(modo) {
    var ejes = { xy: [[0, 1], [1, 1]], yx: [[1, 1], [0, 1]], xy_: [[0, -1], [1, -1]], yx_: [[1, -1], [0, -1]], z: [[2, 1], [0, 1]] }[modo] || [[0, 1], [1, 1]];
    var paso = 0.5;
    return function (a, b) {
      if (a.c && b.c) {
        var p = ejes[0], s = ejes[1];
        var da = Math.round(a.c[p[0]] / paso), db = Math.round(b.c[p[0]] / paso);
        if (da !== db) return (da - db) * p[1];
        if (Math.abs(a.c[s[0]] - b.c[s[0]]) > 1e-3) return (a.c[s[0]] - b.c[s[0]]) * s[1];
      } else if (a.c || b.c) return a.c ? -1 : 1;
      return (a.id || a.ids[0]) - (b.id || b.ids[0]);
    };
  }

  async function colorear(soloReleer) {
    if (!API) return;
    ocupado(true);
    try {
      await verificarAcceso();
      var proyecto = $("proyecto").value.trim();
      guardarLocal("proyecto:" + $("proyecto").dataset.pid, proyecto);
      guardarLocal("orden:" + $("proyecto").dataset.pid, $("orden").value);
      if (!indice) await indexar();
      if (!Object.keys(indice).length) {
        estado("No encontré marcas en los modelos cargados. Revisa en «Diagnóstico» en qué propiedad está la marca.", true);
        return;
      }
      var fu = $("fuente").value;
      filas = fu === "sp" ? await leerSharePoint() : fu === "tc" ? await leerTrimble() : await leerArchivo();
      var vista = $("vista").value;
      if (vista === "combinado") return await colorearCombinado(proyecto);
      var IDX = vista === "piezas" ? indicePiezas : indice;
      var sumas = estadosDe(filas, vista);
      var colores = [C.colorSinAvance].concat(C.etapas.map(function (e) { return e.color; }));
      var cubetas = colores.map(function () { return []; });
      var resumen = [], ocultas = [], visibles = [], modo = modoSec();
      if (modo !== "todo" && C.ocultarTornillos !== false) Array.prototype.push.apply(ocultas, tornillos);
      Object.keys(IDX).sort().forEach(function (m) {
        if (oculta(m)) { if (modo === "sin") Array.prototype.push.apply(ocultas, IDX[m]); return; }
        if (modo === "solo") Array.prototype.push.apply(visibles, IDX[m]);
        var inst = IDX[m].slice().sort(comparadorOrden($("orden").value));
        var s = sumas[m] || C.etapas.map(function () { return 0; });
        var rep = L.repartir(inst.length, s);
        // las primeras piezas reciben la etapa más avanzada
        var pos = 0, kg = rep.map(function () { return 0; }), kgTot = 0;
        for (var b = rep.length - 1; b >= 0; b--) {
          for (var q = 0; q < rep[b]; q++) { var it = inst[pos++]; cubetas[b].push(it); kg[b] += it.peso || 0; kgTot += it.peso || 0; }
        }
        resumen.push({ marca: m, total: inst.length, rep: rep, kg: kg, kgTot: kgTot, reportado: !!sumas[m] });
      });
      estado("Aplicando colores…");
      await API.viewer.setObjectState(undefined, { color: "reset", visible: "reset" });
      if (C.atenuarResto) await API.viewer.setObjectState(undefined, { color: { r: 225, g: 225, b: 225, a: 70 } });
      for (var c = 0; c < colores.length; c++) {
        if (cubetas[c].length) await API.viewer.setObjectState(selector(cubetas[c]), { color: L.rgba(colores[c], 255) });
      }
      resumen.sort(function (x, y) {
        var ax = x.total - x.rep[0], ay = y.total - y.rep[0];
        if ((ax > 0) !== (ay > 0)) return ax > 0 ? -1 : 1;
        if (ax > 0) {
          for (var i = x.rep.length - 1; i >= 1; i--) if (x.rep[i] !== y.rep[i]) return y.rep[i] - x.rep[i];
        }
        return x.marca < y.marca ? -1 : 1;
      });
      var noEnc = Object.keys(sumas).filter(function (m) { return !IDX[m] && !oculta(m); });
      ultimo = { idx: IDX, vista: vista, info: infoMarca, resumen: resumen, noEnc: noEnc, cubetas: cubetas, colores: colores, ocultas: ocultas, visibles: visibles, modo: modo };
      await aplicarFiltro();
      pintarPanel();
      var hora = new Date().toLocaleTimeString("es-GT", { hour: "2-digit", minute: "2-digit" });
      var fr = fechaRevision || fechaAvance;
      $("fechaAvance").innerHTML = fr
        ? "Revisión al <b>" + fr.toLocaleString("es-GT", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) +
          "</b><br><span>" + (fechaRevision ? "«Revisado» de " : "fecha del archivo ") + ultimoArchivo + "</span>"
        : (ultimoArchivo ? "Archivo: " + ultimoArchivo : "");
      estado("Leído a las " + hora + " · " + resumen.length + (vista === "piezas" ? " piezas" : " ensambles") + " en el modelo" +
        textoFiltro() + " · " + Object.keys(sumas).length + " marcas en la revisión.");
      programarAuto();
    } catch (e) {
      estado(e.message || String(e), true);
    } finally {
      ocupado(false);
    }
  }

  function estadoNum(s) { return s ? s.indexOf(1e9) + 1 : 0; }

  async function colorearCombinado(proyecto) {
    var sumE = estadosDe(filas, "ensambles"), infoE = infoMarca;
    var sumP = estadosDe(filas, "piezas"), infoP = infoMarca;
    infoMarca = infoE;
    var cubetas = COMB.map(function () { return []; }), resumen = [], ocultas = [], visibles = [], modo = modoSec();
    if (modo !== "todo" && C.ocultarTornillos !== false) Array.prototype.push.apply(ocultas, tornillos);
    Object.keys(indice).sort().forEach(function (m) {
      if (oculta(m)) { if (modo === "sin") Array.prototype.push.apply(ocultas, indice[m]); return; }
      if (modo === "solo") Array.prototype.push.apply(visibles, indice[m]);
      var E = estadoNum(sumE[m]), kgTot = 0, pzOk = 0, pzTot = 0, cats = {}, faltan = {};
      indice[m].forEach(function (inst) {
        var ids = inst.ids || [inst.id], desde = inst.asm && inst.ids ? 1 : 0;
        if (ids.length <= desde || inst.rec) {          // sin piezas conocidas: vale el estado del ensamble
          var c0 = categoria(E, 0), kg0 = inst.peso || 0;
          cubetas[c0].push(inst); kgTot += kg0; cats[c0] = 1; return;
        }
        if (desde) cubetas[categoria(E, 0)].push({ modelId: inst.modelId, id: ids[0] });   // objeto ensamble
        for (var i = desde; i < ids.length; i++) {
          var k = inst.modelId + ":" + ids[i], pm = pzDe[k], P = pm ? estadoNum(sumP[pm]) : 0;
          var c = categoria(E, P), kg = pesoDe[k] || 0;
          cubetas[c].push({ modelId: inst.modelId, id: ids[i], peso: kg });
          kgTot += kg; pzTot++; cats[c] = 1;
          if ((P || E) === 3) pzOk++; else if (pm) faltan[pm] = 1;
        }
      });
      resumen.push({ marca: m, total: indice[m].length, kgTot: kgTot, e: E, pzOk: pzOk, pzTot: pzTot, faltan: Object.keys(faltan) });
    });
    estado("Aplicando colores…");
    await API.viewer.setObjectState(undefined, { color: "reset", visible: "reset" });
    if (C.atenuarResto) await API.viewer.setObjectState(undefined, { color: { r: 225, g: 225, b: 225, a: 70 } });
    for (var c = 0; c < COMB.length; c++) {
      if (cubetas[c].length) await API.viewer.setObjectState(selector(cubetas[c]), { color: L.rgba(COMB[c].color, 255) });
    }
    resumen.sort(function (x, y) {
      var fx = x.pzTot - x.pzOk, fy = y.pzTot - y.pzOk;
      if ((x.e === 3) !== (y.e === 3)) return x.e === 3 ? 1 : -1;
      if (fx !== fy) return fy - fx;
      return x.marca < y.marca ? -1 : 1;
    });
    var noEnc = Object.keys(sumE).filter(function (m) { return !indice[m] && !oculta(m); });
    ultimo = { idx: indice, vista: "combinado", info: infoE, infoP: infoP, resumen: resumen, noEnc: noEnc, cubetas: cubetas,
               colores: COMB.map(function (x) { return x.color; }), nombres: COMB.map(function (x) { return x.nombre; }),
               ocultas: ocultas, visibles: visibles, modo: modo };
    await aplicarFiltro();
    pintarPanel();
    var fr = fechaRevision || fechaAvance;
    $("fechaAvance").innerHTML = fr
      ? "Revisión al <b>" + fr.toLocaleString("es-GT", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) +
        "</b><br><span>" + (fechaRevision ? "«Revisado» de " : "fecha del archivo ") + ultimoArchivo + "</span>"
      : (ultimoArchivo ? "Archivo: " + ultimoArchivo : "");
    estado("Leído a las " + new Date().toLocaleTimeString("es-GT", { hour: "2-digit", minute: "2-digit" }) + " · " + resumen.length +
      " ensambles en el modelo" + textoFiltro() + " · " + Object.keys(sumE).length + " planos de ensamble y " + Object.keys(sumP).length + " de habilitado en la revisión.");
    programarAuto();
  }

  function programarAuto() {
    if (temporizador) clearInterval(temporizador);
    if ($("fuente").value !== "csv" && C.autoActualizarMin > 0) {
      temporizador = setInterval(function () { colorear(true); }, C.autoActualizarMin * 60000);
    }
  }

  async function quitarColores() {
    if (!API) return;
    if (temporizador) clearInterval(temporizador);
    await API.viewer.setObjectState(undefined, { color: "reset", visible: "reset" });
    estado("Colores restablecidos.");
  }

  // ------------------------------------------------------------ panel: leyenda y tabla
  function ton(kg) { return (kg / 1000).toLocaleString("es-GT", { minimumFractionDigits: 1, maximumFractionDigits: 1 }); }

  var ICO_SEL = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M4 3l7 17 2.5-7.5L21 10z"/></svg>';
  var ICO_OJO = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';

  function pintarLeyendaComb() {
    var u = ultimo, cuentas = [], kgs = [], kgTot = 0, pzTot = 0;
    u.cubetas.forEach(function (l, i) {
      var lst = l.filter(function (x) { return x.peso !== undefined || x.ids; });
      cuentas[i] = lst.length;
      kgs[i] = lst.reduce(function (a, x) { return a + (x.peso || 0); }, 0);
      kgTot += kgs[i]; pzTot += cuentas[i];
    });
    var pct = function (kg) { return kgTot ? (100 * kg / kgTot).toFixed(1) + "%" : ""; };
    var orden = [5, 4, 3, 2, 1, 0];
    var html = '<div class="tit">Estado de planos · ensamble + habilitado</div>' +
      '<table class="ley"><thead><tr><th>Estado de cada pieza del modelo</th><th class="num">Pzas</th><th class="num">Ton</th><th class="num">% peso</th><th></th></tr></thead><tbody>' +
      orden.map(function (i) {
        var acc = cuentas[i]
          ? '<button class="ico" data-sel="' + i + '" title="Seleccionar en el modelo">' + ICO_SEL + "</button>" +
            '<button class="ico" data-solo="' + i + '" title="Mostrar solo estas piezas">' + ICO_OJO + "</button>" : "";
        return "<tr" + (!cuentas[i] ? ' class="vacia"' : "") + '><td><span class="sw" style="background:' + u.colores[i] + '"></span>' + u.nombres[i] +
          '</td><td class="num">' + cuentas[i] + '</td><td class="num">' + ton(kgs[i]) + '</td><td class="num">' + pct(kgs[i]) +
          '</td><td class="accs">' + acc + "</td></tr>";
      }).join("") +
      '<tr class="tot"><td>Total piezas en modelo</td><td class="num">' + pzTot + '</td><td class="num">' + ton(kgTot) +
      '</td><td class="num">100%</td><td class="accs"><button class="ico" id="btnTodo" title="Volver a mostrar todo el modelo">' + ICO_OJO + "</button></td></tr>" +
      "</tbody></table>" +
      '<div class="nota">Cada pieza se pinta según el <b>plano de ensamble</b> de su marca y su <b>plano de habilitado</b> (PDF/NC de la pieza). ' + ICO_SEL + " selecciona · " + ICO_OJO + " muestra solo</div>";
    $("leyenda").innerHTML = html;
    $("encTabla").innerHTML = "<th>Ensamble</th><th class='num'>Cant</th><th class='num'>Ton</th><th>Plano de ensamble</th><th class='num' title='Piezas del ensamble con plano de habilitado'>Habilitado</th>";
  }

  function pintarLeyenda() {
    if (ultimo && ultimo.vista === "combinado") return pintarLeyendaComb();
    var nombres = [C.nombreSinDato].concat(C.etapas.map(function (e) { return e.nombre; }));
    var colores = [C.colorSinAvance].concat(C.etapas.map(function (e) { return e.color; }));
    var cuentas = colores.map(function () { return 0; }), kgs = colores.map(function () { return 0; }), kgTot = 0, pzTot = 0;
    if (ultimo) ultimo.resumen.forEach(function (r) {
      r.rep.forEach(function (v, i) { cuentas[i] += v; kgs[i] += r.kg[i]; pzTot += v; });
      kgTot += r.kgTot;
    });
    var orden = C.etapas.map(function (e, i) { return i + 1; }).concat([0]);
    var pct = function (kg) { return kgTot ? (100 * kg / kgTot).toFixed(1) + "%" : ""; };
    var html = '<div class="tit">Estado de planos · ' + (ultimo && ultimo.vista === "piezas" ? "piezas" : "ensambles") + '</div>' +
      '<table class="ley"><thead><tr><th>Estado</th><th class="num">Pzas</th><th class="num">Ton</th><th class="num">% peso</th><th></th></tr></thead><tbody>' +
      orden.map(function (i) {
        var acc = ultimo && cuentas[i]
          ? '<button class="ico" data-sel="' + i + '" title="Seleccionar en el modelo las ' + cuentas[i] + ' piezas en ' + nombres[i] + '">' + ICO_SEL + "</button>" +
            '<button class="ico" data-solo="' + i + '" title="Mostrar solo las piezas en ' + nombres[i] + '">' + ICO_OJO + "</button>"
          : "";
        return '<tr' + (ultimo && !cuentas[i] ? ' class="vacia"' : "") + '><td><span class="sw" style="background:' + colores[i] + '"></span>' +
          nombres[i] + '</td><td class="num">' + (ultimo ? cuentas[i].toLocaleString("es-GT") : "") + '</td><td class="num">' +
          (ultimo ? ton(kgs[i]) : "") + '</td><td class="num">' + (ultimo ? pct(kgs[i]) : "") + '</td><td class="accs">' + acc + "</td></tr>";
      }).join("") +
      (ultimo ? '<tr class="tot"><td>Total en modelo</td><td class="num">' + pzTot.toLocaleString("es-GT") + '</td><td class="num">' + ton(kgTot) +
        '</td><td class="num">100%</td><td class="accs"><button class="ico" id="btnTodo" title="Volver a mostrar todo el modelo">' + ICO_OJO + "</button></td></tr>" : "") +
      "</tbody></table>";
    if (ultimo && kgTot > 0 && C.mostrarAcumulado) {
      // lo que ya pasó por cada etapa (lo montado también se armó, pintó y despachó)
      var acum = 0, alc = [], alcPz = [], accPz = 0;
      for (var j = C.etapas.length; j >= 1; j--) { acum += kgs[j]; accPz += cuentas[j]; alc[j - 1] = acum; alcPz[j - 1] = accPz; }
      html += '<div class="tit" style="margin-top:10px">Avance acumulado <span style="font-weight:400;color:#6b7280">(lo que ya pasó por cada etapa)</span></div>' +
        C.etapas.map(function (e, i) {
          var p = 100 * alc[i] / kgTot;
          return '<div class="acum"><span class="en">' + e.nombre + '</span><div class="bar"><span style="width:' + p.toFixed(1) + "%;background:" + e.color +
            '"></span></div><span class="vl">' + p.toFixed(1) + "% · " + ton(alc[i]) + " t · " + alcPz[i] + " pzas</span></div>";
        }).join("");
    }
    if (ultimo) html += '<div class="nota">' + ICO_SEL + " selecciona en el modelo · " + ICO_OJO + " muestra solo ese estado</div>";
    $("leyenda").innerHTML = html;
    $("encTabla").innerHTML = "<th>Marca</th><th class='num'>Pzas</th><th class='num'>Ton</th><th>Estado</th><th>Fecha PDF</th>";
  }

  function pintarPanel() {
    pintarLeyenda();
    if (!ultimo) return;
    var f = $("filtro").value.trim().toUpperCase();
    var colores = ultimo.colores;
    var fmtF = function (d) { return d instanceof Date && !isNaN(d) ? d.toLocaleDateString("es-GT", { day: "2-digit", month: "2-digit", year: "2-digit" }) : ""; };
    if (ultimo.vista === "combinado") {
      var colE = [C.colorSinAvance].concat(C.etapas.map(function (e) { return e.color; }));
      $("cuerpo").innerHTML = ultimo.resumen.filter(function (r) { return !f || r.marca.indexOf(f) >= 0; })
        .map(function (r) {
          var inf = ultimo.info[r.marca], nom = r.e ? C.etapas[r.e - 1].nombre : C.nombreSinDato;
          var tip = (inf ? inf.res + (inf.plano ? " · " + inf.plano : "") : "El ensamble no aparece en el Excel") +
            (r.faltan.length ? " · sin plano de habilitado: " + r.faltan.join(", ") : "");
          var todas = r.pzTot && r.pzOk === r.pzTot;
          return '<tr class="click" data-m="' + r.marca + '" title="' + String(tip).replace(/"/g, "'") + '"' + (r.e || r.pzOk ? "" : ' style="color:#9ca3af"') + "><td>" +
            r.marca + "</td><td class='num'>" + r.total + "</td><td class='num'>" + (r.kgTot ? ton(r.kgTot) : "") + "</td>" +
            '<td style="white-space:nowrap"><span class="sw" style="display:inline-block;vertical-align:-2px;margin-right:4px;background:' + colE[r.e] + '"></span>' + nom + "</td>" +
            "<td class='num' style='white-space:nowrap;" + (r.pzTot ? (todas ? "color:#2EAA4A" : "color:#D93025") : "") + "'>" + (r.pzTot ? r.pzOk + "/" + r.pzTot : "") + "</td></tr>";
        }).join("");
      $("noEncontradas").innerHTML = ultimo.noEnc.length
        ? '<div class="aviso">En la revisión de planos pero no encontradas en los modelos cargados: ' + ultimo.noEnc.join(", ") + "</div>" : "";
      return;
    }
    $("cuerpo").innerHTML = ultimo.resumen.filter(function (r) { return !f || r.marca.indexOf(f) >= 0; })
      .map(function (r) {
        var inf = ultimo.info[r.marca], e = inf ? inf.e : 0;
        var nom = e ? C.etapas[e - 1].nombre : C.nombreSinDato;
        var tip = inf ? (inf.res + (inf.plano ? " · " + inf.plano : "") + (inf.desc ? " · " + inf.desc : "")) : "La marca no aparece en el Excel de revisión";
        return '<tr class="click" data-m="' + r.marca + '" title="' + String(tip).replace(/"/g, "'") + '"' + (e ? "" : ' style="color:#9ca3af"') + '><td>' +
          r.marca + "</td><td class='num'>" + r.total + "</td><td class='num'>" + (r.kgTot ? ton(r.kgTot) : "") + "</td>" +
          '<td style="white-space:nowrap"><span class="sw" style="display:inline-block;vertical-align:-2px;margin-right:4px;background:' + colores[e] + '"></span>' + nom + "</td>" +
          "<td style='white-space:nowrap'>" + (inf ? fmtF(inf.fecha) : "") + "</td></tr>";
      }).join("");
    $("noEncontradas").innerHTML = ultimo.noEnc.length
      ? '<div class="aviso">En la revisión de planos pero no encontradas en los modelos cargados: ' + ultimo.noEnc.join(", ") + "</div>"
      : "";
  }

  async function seleccionarEtapa(i, solo) {
    if (!ultimo || !ultimo.cubetas[i].length) return;
    var sel = selector(ultimo.cubetas[i]);
    try {
      if (solo) {
        // igual que "Mostrar solo los seleccionados" del visor
        var ok = false;
        try {
          ok = await API.viewer.isolateEntities(sel.modelObjectIds.map(function (g) {
            return { modelId: g.modelId, entityIds: g.objectRuntimeIds };
          }));
        } catch (e) { ok = false; }
        if (ok === false) {
          // respaldo: ocultar explícitamente todo lo demás
          var mostrar = {};
          sel.modelObjectIds.forEach(function (g) { g.objectRuntimeIds.forEach(function (id) { mostrar[g.modelId + ":" + id] = 1; }); });
          var ocultar = todosIds.map(function (g) {
            return { modelId: g.modelId, objectRuntimeIds: g.objectRuntimeIds.filter(function (id) { return !mostrar[g.modelId + ":" + id]; }) };
          }).filter(function (g) { return g.objectRuntimeIds.length; });
          if (ocultar.length) await API.viewer.setObjectState({ modelObjectIds: ocultar }, { visible: false });
          await API.viewer.setObjectState(sel, { visible: true });
        }
      }
      if (solo && ultimo.ocultas.length) await API.viewer.setObjectState(selector(ultimo.ocultas), { visible: false });
      await API.viewer.setSelection(sel, "set");
      await API.viewer.setCamera(sel, { animationTime: 400 });
      var nombre = ultimo.nombres ? ultimo.nombres[i] : (i === 0 ? C.nombreSinDato : C.etapas[i - 1].nombre);
      var kg = ultimo.cubetas[i].reduce(function (s, x) { return s + (x.peso || 0); }, 0);
      estado((solo ? "Mostrando solo " : "Seleccionadas: ") + nombre + " · " + ultimo.cubetas[i].length + " piezas · " + ton(kg) + " t");
    } catch (e) { estado("No se pudo seleccionar: " + (e.message || e), true); }
  }

  async function mostrarTodo() {
    try {
      if (todosIds.length) await API.viewer.setObjectState({ modelObjectIds: todosIds }, { visible: true });
      await API.viewer.setObjectState(undefined, { visible: "reset" });
      await aplicarFiltro();
      estado("Se muestran todos los objetos" + textoFiltro() + ".");
    } catch (e) {}
  }

  async function seleccionarMarca(m) {
    var IX = ultimo ? ultimo.idx : indice;
    if (!IX || !IX[m]) return;
    var sel = selector(IX[m]);
    try {
      await API.viewer.setSelection(sel, "set");
      await API.viewer.setCamera(sel, { animationTime: 400 });
    } catch (e) {}
  }

  // ------------------------------------------------------------ diagnóstico
  async function diagnostico() {
    var out = $("diag");
    try {
      var sel = await API.viewer.getSelection();
      if (!sel.length || !sel[0].objectRuntimeIds || !sel[0].objectRuntimeIds.length) { out.textContent = "No hay nada seleccionado."; return; }
      var mid = sel[0].modelId, id = sel[0].objectRuntimeIds[0];
      var p = (await API.viewer.getObjectProperties(mid, [id]))[0] || {};
      var txt = "Clase: " + (p.class || "") + "\nProduct.Name: " + (p.product && p.product.name || "") +
        "\nMarca de ensamble detectada: " + (L.marcaDeObjeto(p, C.propiedadesMarca) || "(ninguna)") +
        "\nMarca de pieza detectada: " + (L.marcaDeObjeto(p, C.propiedadesPieza) || "(ninguna)") + "\n\n";
      (p.properties || []).forEach(function (s) {
        (s.properties || []).forEach(function (q) { txt += s.name + "." + q.name + " = " + q.value + "\n"; });
      });
      try {
        var hijos = await API.viewer.getHierarchyChildren(mid, [id], 4, false);
        if (hijos && hijos.length) {
          var hp = (await API.viewer.getObjectProperties(mid, [hijos[0].id]))[0] || {};
          txt += "\n--- Primera pieza del ensamble (" + (hp.class || "") + ") ---\nProduct.Name: " + (hp.product && hp.product.name || "") +
            "\nMarca detectada: " + (L.marcaDeObjeto(hp, C.propiedadesMarca) || "(ninguna)") + "\n";
          (hp.properties || []).forEach(function (s) {
            (s.properties || []).forEach(function (q) { txt += s.name + "." + q.name + " = " + q.value + "\n"; });
          });
        }
      } catch (e) {}
      try {
        var padres = await API.viewer.getHierarchyParents(mid, [id], 4, false);
        if (padres && padres.length) {
          var pp = (await API.viewer.getObjectProperties(mid, [padres[0].id]))[0] || {};
          txt += "\n--- Ensamble padre (" + (pp.class || "") + ") ---\nProduct.Name: " + (pp.product && pp.product.name || "") +
            "\nMarca detectada: " + (L.marcaDeObjeto(pp, C.propiedadesMarca) || "(ninguna)") + "\n";
          (pp.properties || []).forEach(function (s) {
            (s.properties || []).forEach(function (q) { txt += s.name + "." + q.name + " = " + q.value + "\n"; });
          });
        }
      } catch (e) {}
      out.textContent = txt + (diagAcceso ? "\n\n" + diagAcceso : "");
    } catch (e) { out.textContent = "Error: " + (e.message || e); }
  }

  // ------------------------------------------------------------ eventos de la página
  $("fuente").addEventListener("change", function () {
    $("cajaCSV").style.display = this.value === "csv" ? "block" : "none";
    guardarLocal("fuente", this.value);
  });
  var f0 = leerLocal("fuente") || (C.clientId ? "sp" : "tc");
  $("fuente").value = f0; $("cajaCSV").style.display = f0 === "csv" ? "block" : "none";
  $("btnColorear").addEventListener("click", function () { colorear(false); });

  // botones Ensambles / Piezas sueltas
  function marcarVista(v) {
    $("vista").value = v;
    Array.prototype.forEach.call(document.querySelectorAll("#grupoVista button"), function (b) { b.classList.toggle("act", b.dataset.v === v); });
  }
  var v0 = leerLocal("vista");
  marcarVista(v0 === "combinado" ? "combinado" : "ensambles");
  $("grupoVista").addEventListener("click", function (ev) {
    var b = ev.target.closest("button"); if (!b || b.dataset.v === $("vista").value) return;
    marcarVista(b.dataset.v); guardarLocal("vista", b.dataset.v); if (ultimo) colorear(false);
  });
  // botones Todas / Sin secundarios / Solo secundarios
  $("txtSec").textContent = "Secundarios: " + textoOcultables();
  function marcarFiltro(v) {
    $("filtroSec").value = v;
    Array.prototype.forEach.call(document.querySelectorAll("#grupoSec button"), function (b) { b.classList.toggle("act", b.dataset.f === v); });
  }
  var fGuard = leerLocal("filtroSec") || (leerLocal("ocultarCT") === "1" ? "sin" : "todo");
  marcarFiltro(/^(todo|sin|solo)$/.test(fGuard) ? fGuard : "todo");
  $("grupoSec").addEventListener("click", function (ev) {
    var b = ev.target.closest("button"); if (!b || b.dataset.f === $("filtroSec").value) return;
    marcarFiltro(b.dataset.f); guardarLocal("filtroSec", b.dataset.f); if (ultimo) colorear(false);
  });
  $("btnReset").addEventListener("click", quitarColores);
  $("btnDiag").addEventListener("click", diagnostico);
  $("filtro").addEventListener("input", pintarPanel);
  $("leyenda").addEventListener("click", function (ev) {
    var b = ev.target.closest("button"); if (!b) return;
    if (b.id === "btnTodo") return mostrarTodo();
    if (b.dataset.sel !== undefined) return seleccionarEtapa(+b.dataset.sel, false);
    if (b.dataset.solo !== undefined) return seleccionarEtapa(+b.dataset.solo, true);
  });
  $("cuerpo").addEventListener("click", function (ev) {
    var tr = ev.target.closest("tr[data-m]"); if (tr) seleccionarMarca(tr.dataset.m);
  });
  pintarLeyenda();
  conectar();
})();
