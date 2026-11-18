/* ================= CONEXIÓN CON SUPABASE (web propia) =================
   Cuando la plataforma NO se abre dentro de Claude, los datos se guardan en Supabase.
   Este bloque imita la base de datos de Claude (doc/collection/onSnapshot/set/delete)
   para que el resto del programa funcione igual. Los permisos los decide Supabase
   (ver supabase/esquema.sql): cada entrenador solo ve lo suyo y coordinación lo ve todo. */
var SB_URL = 'https://rnbqhzoxmvavktleiblc.supabase.co';
var SB_KEY = 'sb_publishable_ZSof4H6DRxPIhFRZIGQnbA_YuK281gm';
var SB = null, CUENTA = null;

function sbDb(sb, club){
  var cache = {}, colL = [], docL = [];
  function parent(p){ return p.slice(0, p.lastIndexOf('/')); }
  function last(p){ return p.slice(p.lastIndexOf('/') + 1); }
  function fireDoc(l){ var d = cache[l.p]; l.cb({exists: d !== undefined, data: function(){ return d; }}); }
  function fireCol(l){
    var docs = Object.keys(cache).filter(function(k){ return parent(k) === l.p; })
      .map(function(k){ return {id: last(k), data: function(){ return cache[k]; }}; });
    l.cb({docs: docs});
  }
  function emit(p){
    docL.forEach(function(l){ if(l.p === p) fireDoc(l); });
    colL.forEach(function(l){ if(parent(p) === l.p) fireCol(l); });
  }
  var loaded = (async function(){
    var from = 0;
    for(;;){
      var r = await sb.from('docs').select('path,data').eq('club_id', club).range(from, from + 999);
      if(r.error) throw r.error;
      r.data.forEach(function(x){ cache[x.path] = x.data; });
      if(r.data.length < 1000) break;
      from += 1000;
    }
  })();
  sb.channel('docs-' + club)
    .on('postgres_changes', {event: '*', schema: 'public', table: 'docs', filter: 'club_id=eq.' + club}, function(ev){
      if(ev.eventType === 'DELETE'){ var p = ev.old && ev.old.path; if(p && p in cache){ delete cache[p]; emit(p); } }
      else if(ev.new && ev.new.path){ cache[ev.new.path] = ev.new.data; emit(ev.new.path); }
    })
    .subscribe();
  function listen(list, l, fire){
    list.push(l);
    loaded.then(function(){ fire(l); }, function(e){ if(l.err) l.err(e); });
    return function(){ var i = list.indexOf(l); if(i >= 0) list.splice(i, 1); };
  }
  async function put(p, d){
    var r = await sb.from('docs').upsert({club_id: club, path: p, data: d, updated_at: new Date().toISOString()});
    if(r.error) throw r.error;
    cache[p] = d; emit(p);
  }
  async function del(p){
    var r = await sb.from('docs').delete().eq('club_id', club).eq('path', p);
    if(r.error) throw r.error;
    delete cache[p]; emit(p);
  }
  function doc(p){
    return {
      onSnapshot: function(cb, err){ return listen(docL, {p: p, cb: cb, err: err}, fireDoc); },
      set: function(d){ return put(p, d); },
      delete: function(){ return del(p); }
    };
  }
  function collection(p){
    return {
      onSnapshot: function(cb, err){ return listen(colL, {p: p, cb: cb, err: err}, fireCol); },
      doc: function(i){ return doc(p + '/' + i); }
    };
  }
  return {doc: doc, collection: collection};
}

function sbUser(sb, uid){
  return {
    isOwner: async function(){ return CUENTA && CUENTA.rol === 'coord'; },
    id: async function(){ return uid; },
    can: async function(){ return true; },
    profiles: async function(ids){
      var r = await sb.from('miembros').select('user_id,nombre').in('user_id', ids);
      var o = {}; (r.data || []).forEach(function(x){ o[x.user_id] = {name: x.nombre}; });
      return o;
    }
  };
}

var sbDownloads = {
  save: async function(o){
    var blob = o.data instanceof Blob ? o.data : new Blob([o.data], {type: 'application/json'});
    var url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = o.filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function(){ URL.revokeObjectURL(url); }, 4000);
  }
};

/* ---------- Pantalla de acceso ---------- */
function vAcceso(modo, msg){
  var h = '<header class="band"><div class="inner"><h1>Metodix<small>Metodología y sesiones de fútbol formativo</small></h1></div></header>' +
    '<main class="inner" style="max-width:460px"><div class="card" style="margin-top:28px"><form id="acceso" class="edit" data-modo="'+modo+'">';
  if(modo === 'entrar'){
    h += '<h2 style="font:700 26px/1.1 var(--display)">Entrar</h2>' +
      '<div class="field"><label for="ac-email">Correo electrónico</label><input id="ac-email" type="email" autocomplete="email" required></div>' +
      '<div class="field"><label for="ac-pass">Contraseña</label><input id="ac-pass" type="password" autocomplete="current-password" required minlength="6"></div>' +
      '<button class="btn" type="submit">Entrar</button>' +
      '<div class="row" style="justify-content:space-between"><button type="button" class="btn ghost small" data-acc="registro">Crear cuenta</button><button type="button" class="btn ghost small" data-acc="olvido">He olvidado la contraseña</button></div>';
  } else if(modo === 'registro'){
    h += '<h2 style="font:700 26px/1.1 var(--display)">Crear cuenta</h2>' +
      '<p class="note">Necesitas el código de tu club. Te lo da la coordinación.</p>' +
      '<div class="field"><label for="ac-nombre">Nombre y apellidos</label><input id="ac-nombre" autocomplete="name" required></div>' +
      '<div class="field"><label for="ac-codigo">Código del club</label><input id="ac-codigo" autocapitalize="characters" required></div>' +
      '<div class="field"><label for="ac-email">Correo electrónico</label><input id="ac-email" type="email" autocomplete="email" required></div>' +
      '<div class="field"><label for="ac-pass">Contraseña (mínimo 6 caracteres)</label><input id="ac-pass" type="password" autocomplete="new-password" required minlength="6"></div>' +
      '<button class="btn" type="submit">Crear cuenta</button>' +
      '<button type="button" class="btn ghost small" data-acc="entrar">Ya tengo cuenta</button>';
  } else if(modo === 'club'){
    h += '<h2 style="font:700 26px/1.1 var(--display)">Únete a tu club</h2>' +
      '<p class="note">Tu cuenta todavía no está en ningún club. Escribe el código que te ha dado la coordinación.</p>' +
      '<div class="field"><label for="ac-nombre">Nombre y apellidos</label><input id="ac-nombre" autocomplete="name"></div>' +
      '<div class="field"><label for="ac-codigo">Código del club</label><input id="ac-codigo" autocapitalize="characters" required></div>' +
      '<button class="btn" type="submit">Unirme</button>' +
      '<button type="button" class="btn ghost small" data-acc="salir">Salir</button>';
  } else if(modo === 'olvido'){
    h += '<h2 style="font:700 26px/1.1 var(--display)">Recuperar contraseña</h2>' +
      '<p class="note">Te enviaremos un correo con un enlace para poner una contraseña nueva.</p>' +
      '<div class="field"><label for="ac-email">Correo electrónico</label><input id="ac-email" type="email" autocomplete="email" required></div>' +
      '<button class="btn" type="submit">Enviar enlace</button>' +
      '<button type="button" class="btn ghost small" data-acc="entrar">Volver</button>';
  } else if(modo === 'nueva'){
    h += '<h2 style="font:700 26px/1.1 var(--display)">Nueva contraseña</h2>' +
      '<div class="field"><label for="ac-pass">Contraseña nueva (mínimo 6 caracteres)</label><input id="ac-pass" type="password" autocomplete="new-password" required minlength="6"></div>' +
      '<button class="btn" type="submit">Guardar</button>';
  }
  if(msg) h += '<p class="banner" role="status">' + esc(msg) + '</p>';
  return h + '</form></div></main>';
}
function acceso(modo, msg){ S.ready = true; S.acceso = modo; app.innerHTML = vAcceso(modo, msg); }

document.addEventListener('click', function(e){
  var b = e.target.closest('[data-acc]'); if(!b || !SB) return;
  var m = b.dataset.acc;
  if(m === 'salir'){ SB.auth.signOut().then(function(){ location.reload(); }); return; }
  acceso(m);
});
document.addEventListener('submit', async function(e){
  if(e.target.id !== 'acceso' || !SB) return;
  e.preventDefault();
  var f = e.target, modo = f.dataset.modo, btn = f.querySelector('button[type=submit]');
  function v(id){ var el = document.getElementById(id); return el ? el.value.trim() : ''; }
  btn.disabled = true;
  try{
    if(modo === 'entrar'){
      var r = await SB.auth.signInWithPassword({email: v('ac-email'), password: document.getElementById('ac-pass').value});
      if(r.error) throw r.error;
      location.reload();
    } else if(modo === 'registro'){
      var r2 = await SB.auth.signUp({email: v('ac-email'), password: document.getElementById('ac-pass').value,
        options: {data: {nombre: v('ac-nombre'), codigo: v('ac-codigo').toUpperCase()}, emailRedirectTo: location.origin + location.pathname}});
      if(r2.error) throw r2.error;
      if(r2.data.session){ location.reload(); }
      else acceso('entrar', 'Te hemos enviado un correo para confirmar tu cuenta. Ábrelo, pulsa el enlace y después entra aquí con tu correo y contraseña.');
    } else if(modo === 'club'){
      var r3 = await SB.rpc('unirse_club', {codigo: v('ac-codigo'), nombre: v('ac-nombre')});
      if(r3.error) throw r3.error;
      location.reload();
    } else if(modo === 'olvido'){
      var r4 = await SB.auth.resetPasswordForEmail(v('ac-email'), {redirectTo: location.origin + location.pathname});
      if(r4.error) throw r4.error;
      acceso('entrar', 'Si ese correo tiene cuenta, te llegará un enlace en unos minutos.');
    } else if(modo === 'nueva'){
      var r5 = await SB.auth.updateUser({password: document.getElementById('ac-pass').value});
      if(r5.error) throw r5.error;
      location.hash = ''; location.reload();
    }
  }catch(err){
    var m = (err && err.message) || 'Algo ha fallado.';
    if(/Invalid login/i.test(m)) m = 'Correo o contraseña incorrectos.';
    else if(/Email not confirmed/i.test(m)) m = 'Todavía no has confirmado tu correo. Revisa tu bandeja de entrada (y la de spam).';
    else if(/already registered/i.test(m)) m = 'Ya hay una cuenta con ese correo. Entra con ella.';
    else if(/rate limit/i.test(m)) m = 'Se han enviado demasiados correos en poco tiempo. Prueba de nuevo dentro de un rato.';
    var p = f.querySelector('.banner'); if(!p){ p = document.createElement('p'); p.className = 'banner'; f.appendChild(p); }
    p.textContent = m; btn.disabled = false;
  }
});

/* Devuelve {db, dl, u} si hay sesión y club; si no, muestra la pantalla de acceso y devuelve null */
async function sbInit(){
  if(!window.supabase){ acceso('entrar', 'No se ha podido cargar la conexión. Comprueba tu internet y recarga la página.'); return null; }
  SB = window.supabase.createClient(SB_URL, SB_KEY);
  if(/type=recovery/.test(location.hash)){
    await new Promise(function(r){ setTimeout(r, 400); });
    acceso('nueva'); return null;
  }
  var ses = (await SB.auth.getSession()).data.session;
  if(!ses){ acceso('entrar'); return null; }
  var uid = ses.user.id;
  var c = await SB.rpc('mi_cuenta');
  CUENTA = c.data;
  if(!CUENTA){
    var md = ses.user.user_metadata || {};
    if(md.codigo){
      var j = await SB.rpc('unirse_club', {codigo: md.codigo, nombre: md.nombre || ''});
      if(!j.error){ CUENTA = (await SB.rpc('mi_cuenta')).data; }
    }
  }
  if(!CUENTA){ acceso('club'); return null; }
  S.clubName = CUENTA.club;
  return {db: sbDb(SB, CUENTA.club_id), dl: sbDownloads, u: sbUser(SB, uid)};
}
