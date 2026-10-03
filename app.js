import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.39.7/+esm';

const SUPABASE_URL = 'https://daouhyikdlahagxoqdsk.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRhb3VoeWlrZGxhaGFneG9xZHNrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTEwNTQ1NzAsImV4cCI6MjEwNjYzMDU3MH0.0I1c7DMxUEjF36p5oZbTvC2OBtGY9IS4xrvXdY0yfqw';
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const $ = (id) => document.getElementById(id);
const BLUE = '#1e90ff';

let me = null;               // {id, username, display_name, email}
let mode = 'signup';         // auth mode
let activeView = 'view-chats';
let threadOther = null;      // profile of open thread
let profilesCache = {};      // id -> profile
let camStream = null, facing = 'user';
let landmarker = null, landmarkerLoading = false;
let lastVideoTime = -1, faceLm = null, camRunning = false;
let filterIndex = 0;
let storyState = { items: [], idx: 0, timer: null };

/* ================= helpers ================= */
function esc(s){ return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function relTime(iso){
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return Math.floor(s/60) + 'm';
  if (s < 86400) return Math.floor(s/3600) + 'h';
  return Math.floor(s/86400) + 'd';
}
function avatarHTML(p, cls=''){
  const ch = esc((p.display_name || p.username || '?')[0]);
  return `<div class="avatar ${cls}">${ch}</div>`;
}
function show(id){ $(id).classList.remove('hidden'); }
function hide(id){ $(id).classList.add('hidden'); }
function toast(msg){ const e = $('auth-error'); if(e){ e.textContent = msg; } }

/* ================= auth ================= */
async function init(){
  const { data } = await sb.auth.getSession();
  if (data.session) { await enterApp(data.session.user); }
  else { show('screen-auth'); }
  wireAuth(); wireTabs(); wireCamera(); wireChat(); wireStories(); wireModals();
}

function wireAuth(){
  $('btn-auth-toggle').onclick = () => {
    mode = mode === 'signup' ? 'signin' : 'signup';
    $('btn-auth').textContent = mode === 'signup' ? 'Sign up' : 'Sign in';
    $('btn-auth-toggle').textContent = mode === 'signup' ? 'already have an account? sign in' : 'new here? create an account';
    $('auth-signup-fields').style.display = mode === 'signup' ? '' : 'none';
    $('auth-error').textContent = '';
  };
  $('btn-auth').onclick = doAuth;
}

async function doAuth(){
  const email = $('auth-email').value.trim();
  const pw = $('auth-password').value;
  $('auth-error').textContent = '';
  if (!email || !pw) { $('auth-error').textContent = 'Enter email and password.'; return; }
  $('btn-auth').disabled = true;
  try {
    if (mode === 'signup') {
      const username = $('auth-username').value.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
      const display_name = $('auth-displayname').value.trim() || username;
      if (username.length < 3) throw new Error('Pick a username (3+ letters/numbers).');
      const { data, error } = await sb.auth.signUp({ email, password: pw });
      if (error) throw error;
      const user = data.user;
      if (!data.session) { $('auth-error').textContent = 'Check your email to confirm, then sign in.'; return; }
      const { error: pErr } = await sb.from('blip_profiles').insert({ id: user.id, username, display_name });
      if (pErr) {
        if (pErr.code === '23505') throw new Error('That username is taken.');
        throw pErr;
      }
      await enterApp(user);
    } else {
      const { data, error } = await sb.auth.signInWithPassword({ email, password: pw });
      if (error) throw error;
      await enterApp(data.user);
    }
  } catch (e) { $('auth-error').textContent = e.message; }
  finally { $('btn-auth').disabled = false; }
}

async function enterApp(user){
  let { data: prof } = await sb.from('blip_profiles').select('*').eq('id', user.id).single();
  if (!prof) { // session restored but profile missing (shouldn't happen) -> sign out
    await sb.auth.signOut(); location.reload(); return;
  }
  me = { ...prof, email: user.email };
  profilesCache[me.id] = prof;
  hide('screen-auth'); show('screen-main');
  switchView('view-chats');
  loadChats(); loadStories();
  subscribeRealtime();
}

/* ================= tabs ================= */
function wireTabs(){
  document.querySelectorAll('.tab').forEach(t => {
    t.onclick = () => switchView(t.dataset.view);
  });
}
function switchView(v){
  activeView = v;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === v));
  ['view-chats','view-camera','view-stories'].forEach(id => $(id).classList.toggle('hidden', id !== v));
  if (v === 'view-camera') startCamera();
  else stopCamera();
  if (v === 'view-chats') loadChats();
  if (v === 'view-stories') loadStories();
}

/* ================= camera + AR ================= */
const FILTERS = ['None', 'Dog', 'Shades', 'Party hat'];

function wireCamera(){
  const bar = $('filter-bar');
  FILTERS.forEach((f, i) => {
    const b = document.createElement('button');
    b.className = 'filter-chip' + (i === 0 ? ' active' : '');
    b.textContent = f;
    b.onclick = () => {
      filterIndex = i;
      bar.querySelectorAll('.filter-chip').forEach((c, j) => c.classList.toggle('active', j === i));
    };
    bar.appendChild(b);
  });
  $('btn-shutter').onclick = capturePhoto;
  $('btn-cam-start').onclick = startCamera;
  $('btn-flip').onclick = () => { facing = facing === 'user' ? 'environment' : 'user'; startCamera(); };
  $('file-upload').onchange = (e) => { const f = e.target.files[0]; if (f) uploadFallback(f); e.target.value=''; };
}

async function startCamera(){
  hide('cam-off');
  if (camStream) { camRunning = true; requestAnimationFrame(camTick); return; }
  try {
    camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing }, audio: false });
  } catch (e) {
    show('cam-off'); return;
  }
  const v = document.createElement('video');
  v.srcObject = camStream; v.muted = true; v.playsInline = true;
  await v.play();
  window._blipVideo = v;
  show('btn-flip');
  camRunning = true;
  requestAnimationFrame(camTick);
  ensureLandmarker();
}

function stopCamera(){
  camRunning = false;
  if (camStream) { camStream.getTracks().forEach(t => t.stop()); camStream = null; window._blipVideo = null; }
  hide('btn-flip');
}

async function ensureLandmarker(){
  if (landmarker || landmarkerLoading) return;
  landmarkerLoading = true; show('cam-loading');
  try {
    const mod = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs');
    const fileset = await mod.FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm');
    landmarker = await mod.FaceLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
        delegate: 'GPU'
      },
      runningMode: 'VIDEO', numFaces: 1
    });
  } catch (e) { landmarker = null; }
  landmarkerLoading = false; hide('cam-loading');
}

function camTick(){
  if (!camRunning) return;
  const v = window._blipVideo, canvas = $('cam-canvas');
  if (!v || v.readyState < 2) { requestAnimationFrame(camTick); return; }
  const W = v.videoWidth, H = v.videoHeight;
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.translate(W, 0); ctx.scale(-1, 1);           // selfie mirror
  ctx.drawImage(v, 0, 0, W, H);
  ctx.restore();
  if (landmarker && v.currentTime !== lastVideoTime) {
    lastVideoTime = v.currentTime;
    try {
      const r = landmarker.detectForVideo(v, performance.now());
      faceLm = (r.faceLandmarks && r.faceLandmarks[0]) || null;
    } catch (e) { faceLm = null; }
  }
  if (faceLm) drawFilter(ctx, W, H);
  requestAnimationFrame(camTick);
}

function P(lm, i, W, H){ return { x: (1 - lm[i].x) * W, y: lm[i].y * H }; }  // mirrored coords
function dist(a, b){ return Math.hypot(a.x - b.x, a.y - b.y); }

function drawFilter(ctx, W, H){
  const lm = faceLm, name = FILTERS[filterIndex];
  if (name === 'None') return;
  const eyeL = P(lm, 33, W, H), eyeR = P(lm, 263, W, H);
  const nose = P(lm, 1, W, H), fore = P(lm, 10, W, H);
  const eyeD = dist(eyeL, eyeR);
  const midX = (eyeL.x + eyeR.x) / 2, midY = (eyeL.y + eyeR.y) / 2;

  if (name === 'Dog') {
    // ears
    ctx.fillStyle = '#8b5a2b';
    const earW = eyeD * 0.55, earH = eyeD * 0.9;
    [[-1, 1], [1, 1]].forEach(([s]) => {
      const ex = fore.x + s * eyeD * 0.62, ey = fore.y - earH * 0.55;
      ctx.beginPath();
      ctx.moveTo(ex - earW/2, ey + earH/2);
      ctx.quadraticCurveTo(ex - earW/2, ey - earH/2, ex, ey - earH/2);
      ctx.quadraticCurveTo(ex + earW/2, ey - earH/2, ex + earW/2, ey + earH/2);
      ctx.quadraticCurveTo(ex, ey + earH*0.15, ex - earW/2, ey + earH/2);
      ctx.fill();
    });
    // nose
    ctx.fillStyle = '#222';
    ctx.beginPath(); ctx.ellipse(nose.x, nose.y, eyeD*0.16, eyeD*0.12, 0, 0, 7); ctx.fill();
  } else if (name === 'Shades') {
    ctx.fillStyle = 'rgba(10,10,12,.94)';
    const w = eyeD * 1.35, h = eyeD * 0.52;
    const x = midX - w/2, y = midY - h/2;
    ctx.beginPath(); ctx.roundRect(x, y, w, h, h/2); ctx.fill();
    ctx.fillRect(midX - eyeD*0.08, y + h*0.28, eyeD*0.16, h*0.16); // bridge
    ctx.strokeStyle = '#333'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x, y + h*0.3); ctx.lineTo(x - eyeD*0.35, y); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x + w, y + h*0.3); ctx.lineTo(x + w + eyeD*0.35, y); ctx.stroke();
  } else if (name === 'Party hat') {
    const hw = eyeD * 0.7, hh = eyeD * 1.15;
    const bx = fore.x, by = fore.y - eyeD * 0.12;
    const grad = ctx.createLinearGradient(bx, by - hh, bx, by);
    grad.addColorStop(0, BLUE); grad.addColorStop(1, '#7cc4ff');
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.moveTo(bx - hw/2, by); ctx.lineTo(bx + hw/2, by); ctx.lineTo(bx, by - hh); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#fff';
    for (let i = 1; i <= 3; i++) {
      const yy = by - (hh * i / 4);
      const ww = hw * (1 - i/4) / 2;
      ctx.fillRect(bx - ww, yy - 2, ww * 2, 4);
    }
    ctx.beginPath(); ctx.arc(bx, by - hh, eyeD*0.11, 0, 7); ctx.fill();
  }
}

function capturePhoto(){
  const canvas = $('cam-canvas');
  if (!canvas.width) return;
  canvas.toBlob(async (blob) => {
    if (!blob) return;
    const url = await uploadImage(blob);
    if (url) openSendSheet(url);
  }, 'image/jpeg', 0.85);
}

async function uploadFallback(file){
  const img = new Image();
  img.src = URL.createObjectURL(file);
  await img.decode();
  const c = document.createElement('canvas');
  const s = Math.min(1, 1280 / Math.max(img.width, img.height));
  c.width = img.width * s; c.height = img.height * s;
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
  const url = await uploadImage(blob);
  if (url) openSendSheet(url);
}

async function uploadImage(blob){
  const path = `${me.id}/${Date.now()}.jpg`;
  const { error } = await sb.storage.from('blip-media').upload(path, blob, { contentType: 'image/jpeg' });
  if (error) { alert('Upload failed: ' + error.message); return null; }
  return sb.storage.from('blip-media').getPublicUrl(path).data.publicUrl;
}

/* ================= send sheet ================= */
async function openSendSheet(imageUrl){
  $('send-preview').src = imageUrl;
  const list = $('send-list'); list.innerHTML = '<p class="dim">Loading…</p>';
  show('sheet-send');
  const threads = await getThreads();
  list.innerHTML = '';
  threads.forEach(t => {
    const r = document.createElement('div');
    r.className = 'row';
    r.innerHTML = avatarHTML(t.other) + `<div class="row-main"><div class="row-name">${esc(t.other.display_name)}</div><div class="row-preview">@${esc(t.other.username)}</div></div>`;
    r.onclick = async () => { hide('sheet-send'); await sendMessage(t.other.id, '', imageUrl); openThread(t.other); };
    list.appendChild(r);
  });
  if (!threads.length) list.innerHTML = '<p class="dim">No chats yet — add a friend first.</p>';
  $('btn-send-story').onclick = async () => {
    hide('sheet-send');
    const { error } = await sb.from('blip_stories').insert({
      user_id: me.id, image_url: imageUrl,
      expires_at: new Date(Date.now() + 864e5).toISOString()
    });
    if (error) alert('Could not post story: ' + error.message);
    else { switchView('view-stories'); loadStories(); }
  };
}

/* ================= chats ================= */
function wireChat(){
  $('btn-thread-back').onclick = () => { threadOther = null; hide('screen-thread'); show('screen-main'); loadChats(); };
  $('thread-form').onsubmit = async (e) => {
    e.preventDefault();
    const t = $('thread-text').value.trim();
    if (!t || !threadOther) return;
    $('thread-text').value = '';
    await sendMessage(threadOther.id, t, null);
  };
  $('btn-thread-cam').onclick = () => { hide('screen-thread'); show('screen-main'); switchView('view-camera'); };
}

async function getThreads(){
  const { data, error } = await sb.from('blip_messages')
    .select('*')
    .or(`sender_id.eq.${me.id},receiver_id.eq.${me.id}`)
    .order('created_at', { ascending: false }).limit(300);
  if (error || !data) return [];
  const seen = new Map();
  for (const m of data) {
    const otherId = m.sender_id === me.id ? m.receiver_id : m.sender_id;
    if (!seen.has(otherId)) seen.set(otherId, m);
  }
  const ids = [...seen.keys()];
  await fetchProfiles(ids);
  return ids.map(id => ({ other: profilesCache[id] || { id, username: '?', display_name: '?' }, last: seen.get(id) }))
    .filter(t => t.other.username !== '?');
}

async function fetchProfiles(ids){
  const missing = ids.filter(id => !profilesCache[id]);
  if (!missing.length) return;
  const { data } = await sb.from('blip_profiles').select('*').in('id', missing);
  (data || []).forEach(p => profilesCache[p.id] = p);
}

async function loadChats(){
  const list = $('chat-list'); list.innerHTML = '';
  const threads = await getThreads();
  $('chats-empty').classList.toggle('hidden', threads.length > 0);
  threads.forEach(t => {
    const m = t.last;
    const prev = m.image_url ? '📷 Photo' : m.body;
    const r = document.createElement('div');
    r.className = 'row';
    r.innerHTML = avatarHTML(t.other) +
      `<div class="row-main"><div class="row-name">${esc(t.other.display_name)}</div><div class="row-preview">${esc(prev)}</div></div>` +
      `<div class="row-time">${relTime(m.created_at)}</div>`;
    r.onclick = () => openThread(t.other);
    list.appendChild(r);
  });
}

async function openThread(other){
  threadOther = other;
  $('thread-name').textContent = other.display_name;
  $('thread-messages').innerHTML = '';
  hide('screen-main'); show('screen-thread');
  await loadThreadMessages();
  const box = $('thread-messages');
  box.scrollTop = box.scrollHeight;
}

async function loadThreadMessages(){
  const { data } = await sb.from('blip_messages').select('*')
    .or(`and(sender_id.eq.${me.id},receiver_id.eq.${threadOther.id}),and(sender_id.eq.${threadOther.id},receiver_id.eq.${me.id})`)
    .order('created_at', { ascending: true }).limit(500);
  const box = $('thread-messages'); box.innerHTML = '';
  (data || []).forEach(m => box.appendChild(bubble(m)));
}

function bubble(m){
  const d = document.createElement('div');
  d.className = 'bubble ' + (m.sender_id === me.id ? 'me' : 'them');
  d.dataset.mid = m.id;
  d.innerHTML = (m.image_url ? `<img src="${esc(m.image_url)}" alt="">` : '') +
    (m.body ? `<div>${esc(m.body)}</div>` : '') +
    `<div class="t">${relTime(m.created_at)}</div>`;
  return d;
}

async function sendMessage(receiverId, body, imageUrl){
  const { data, error } = await sb.from('blip_messages')
    .insert({ sender_id: me.id, receiver_id: receiverId, body: body || null, image_url: imageUrl || null })
    .select().single();
  if (error) { alert('Could not send: ' + error.message); return; }
  if (threadOther && threadOther.id === receiverId) {
    $('thread-messages').appendChild(bubble(data));
    $('thread-messages').scrollTop = $('thread-messages').scrollHeight;
  }
}

function subscribeRealtime(){
  sb.channel('blip-feed')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'blip_messages' }, (p) => {
      const m = p.new;
      if (m.sender_id !== me.id && m.receiver_id !== me.id) return;
      if (threadOther && (m.sender_id === threadOther.id || m.receiver_id === threadOther.id) && !$('screen-thread').classList.contains('hidden')) {
        if (!document.querySelector(`[data-mid="${m.id}"]`)) {
          $('thread-messages').appendChild(bubble(m));
          $('thread-messages').scrollTop = $('thread-messages').scrollHeight;
        }
      }
      if (activeView === 'view-chats' && $('screen-thread').classList.contains('hidden')) loadChats();
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'blip_stories' }, () => {
      if (activeView === 'view-stories') loadStories();
    })
    .subscribe();
}

/* ================= stories ================= */
function wireStories(){ /* loaded on view switch */ }

async function loadStories(){
  const { data } = await sb.from('blip_stories').select('*')
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false }).limit(100);
  const tray = $('story-tray'); tray.innerHTML = '';
  const items = data || [];
  $('stories-empty').classList.toggle('hidden', items.length > 0);
  const byUser = new Map();
  items.forEach(s => { if (!byUser.has(s.user_id)) byUser.set(s.user_id, []); byUser.get(s.user_id).push(s); });
  await fetchProfiles([...byUser.keys()]);
  // my story first
  const mine = byUser.get(me.id);
  const mkItem = (p, stories, label) => {
    const b = document.createElement('button');
    b.className = 'story-item';
    b.innerHTML = `<div class="story-ring"><div class="avatar">${esc((p.display_name||'?')[0])}</div></div><span>${esc(label)}</span>`;
    b.onclick = () => openStoryViewer(p, stories);
    tray.appendChild(b);
  };
  mkItem(me, mine || [], mine ? 'My story' : 'Add story');
  [...byUser.entries()].filter(([id]) => id !== me.id).forEach(([id, stories]) => {
    mkItem(profilesCache[id] || { display_name: '?' }, stories, (profilesCache[id] || {}).display_name || '?');
  });
  // tap "Add story" with none -> go to camera
  if (!mine) tray.querySelector('.story-item').onclick = () => switchView('view-camera');
}

function openStoryViewer(who, stories){
  if (!stories.length) return;
  storyState = { who, items: stories, idx: 0, timer: null };
  show('screen-story');
  renderStorySeg();
}
function renderStorySeg(){
  const { who, items, idx } = storyState;
  $('story-who').textContent = who.display_name || who.username;
  $('story-img').src = items[idx].image_url;
  const prog = $('story-progress'); prog.innerHTML = '';
  items.forEach((_, i) => {
    const s = document.createElement('div'); s.className = 'seg';
    s.innerHTML = `<i style="width:${i < idx ? 100 : 0}%"></i>`; prog.appendChild(s);
  });
  clearTimeout(storyState.timer);
  const bar = prog.children[idx].firstChild;
  bar.style.transition = 'none'; bar.style.width = '0';
  requestAnimationFrame(() => { bar.style.transition = 'width 5s linear'; bar.style.width = '100%'; });
  storyState.timer = setTimeout(() => {
    if (storyState.idx + 1 < storyState.items.length) { storyState.idx++; renderStorySeg(); }
    else closeStoryViewer();
  }, 5000);
}
function closeStoryViewer(){ clearTimeout(storyState.timer); hide('screen-story'); }
$('btn-story-close').onclick = closeStoryViewer;
$('story-tap-right').onclick = () => { if (storyState.idx + 1 < storyState.items.length) { storyState.idx++; renderStorySeg(); } else closeStoryViewer(); };
$('story-tap-left').onclick = () => { if (storyState.idx > 0) { storyState.idx--; renderStorySeg(); } };

/* ================= modals ================= */
function wireModals(){
  $('btn-add-friend').onclick = () => { $('add-username').value=''; $('add-result').innerHTML=''; $('add-error').textContent=''; show('modal-add'); };
  $('btn-add-cancel').onclick = () => hide('modal-add');
  $('btn-add-search').onclick = async () => {
    const q = $('add-username').value.trim().toLowerCase();
    $('add-error').textContent = '';
    if (!q) return;
    const { data } = await sb.from('blip_profiles').select('*').ilike('username', q).limit(5);
    const box = $('add-result'); box.innerHTML = '';
    if (!data || !data.length) { box.innerHTML = '<p class="dim">No one found with that username.</p>'; return; }
    data.filter(p => p.id !== me.id).forEach(p => {
      profilesCache[p.id] = p;
      const r = document.createElement('div');
      r.className = 'row';
      r.innerHTML = avatarHTML(p) + `<div class="row-main"><div class="row-name">${esc(p.display_name)}</div><div class="row-preview">@${esc(p.username)}</div></div>`;
      r.onclick = () => { hide('modal-add'); openThread(p); };
      box.appendChild(r);
    });
  };
  $('btn-me').onclick = () => { $('me-username').textContent = '@' + me.username; $('me-email').textContent = me.email; show('modal-me'); };
  $('btn-me-close').onclick = () => hide('modal-me');
  $('btn-signout').onclick = async () => { await sb.auth.signOut(); location.reload(); };
  $('btn-send-cancel').onclick = () => hide('sheet-send');
}

init();
