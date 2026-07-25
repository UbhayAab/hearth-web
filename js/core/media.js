// Media: upload through the mint-upload edge function, inline render, and an
// in-app viewer. The hard rule for this product: tapping media NEVER hands off to
// another app or another tab. Everything renders in-page.
import { SUPABASE_URL, PUBLISHABLE, MAX_UPLOAD_BYTES } from '../config.js';
import { sb, accessToken } from '../sb.js';
import { api } from '../api.js';
import { store } from '../store.js';
import { esc, el, fmtSize } from '../util.js';
import { toast } from '../ui.js';

const urlCache = new Map();

async function sha256hex(buf) {
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function probeDims(file) {
  const t = file.type || '';
  if (t.startsWith('image/')) {
    return new Promise((res) => {
      const u = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { res({ w: img.naturalWidth, h: img.naturalHeight, ms: null }); URL.revokeObjectURL(u); };
      img.onerror = () => { res(null); URL.revokeObjectURL(u); };
      img.src = u;
    });
  }
  if (t.startsWith('video/')) {
    return new Promise((res) => {
      const u = URL.createObjectURL(file);
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.onloadedmetadata = () => {
        res({ w: v.videoWidth, h: v.videoHeight, ms: Math.round((v.duration || 0) * 1000) });
        URL.revokeObjectURL(u);
      };
      v.onerror = () => { res(null); URL.revokeObjectURL(u); };
      v.src = u;
    });
  }
  return Promise.resolve(null);
}

export async function uploadFile(file, onProgress) {
  if (file.size > MAX_UPLOAD_BYTES) throw new Error(`Too large (max ${fmtSize(MAX_UPLOAD_BYTES)})`);
  const buf = await file.arrayBuffer();
  const sha = await sha256hex(buf);
  const d = await probeDims(file);
  const mime = file.type || 'application/octet-stream';
  onProgress?.(0.2);

  const res = await fetch(SUPABASE_URL + '/functions/v1/mint-upload', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + (await accessToken()),
      apikey: PUBLISHABLE,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ workspace_id: store.ws.id, mime, byte_size: file.size, sha256: sha }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error || 'upload rejected');
  onProgress?.(0.4);

  // Content-addressed: an identical file already stored is reused, no re-upload.
  if (!j.deduped) {
    const { error } = await sb.storage.from('attachments').uploadToSignedUrl(j.object_key, j.token, file);
    if (error) throw error;
    onProgress?.(0.9);
    await api.finalizeAttachment({
      objectKey: j.object_key, sha256: '\\x' + sha, mime, byteSize: file.size,
      width: d?.w ?? null, height: d?.h ?? null, durationMs: d?.ms ?? null, thumbhash: null,
    });
  }
  onProgress?.(1);
  return {
    object_key: j.object_key, mime, width: d?.w, height: d?.h,
    duration_ms: d?.ms, name: file.name, size: file.size,
  };
}

export async function mediaUrl(key) {
  if (urlCache.has(key)) return urlCache.get(key);
  const res = await fetch(SUPABASE_URL + '/functions/v1/mint-download', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + (await accessToken()),
      apikey: PUBLISHABLE,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ object_key: key }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.url) return null;
  urlCache.set(key, j.url);
  // Signed URLs expire; drop the cache entry well before they do.
  setTimeout(() => urlCache.delete(key), 250000);
  return j.url;
}

// Markup only. Real sources are attached later by hydrateMedia so the layout box
// is reserved up front (no shift when the image arrives).
export function attsHtml(m) {
  const a = Array.isArray(m.attachments) ? m.attachments : [];
  if (!a.length) return '';
  return '<div class="atts">' + a.map((x) => {
    const mime = x.mime || '';
    const ratio = x.width && x.height ? `${x.width}/${x.height}` : '4/3';
    const w = Math.min(340, x.width || 340);
    if (mime.startsWith('image/')) {
      return `<div class="att-img" data-key="${esc(x.object_key)}" data-name="${esc(x.name || 'image')}"
        style="width:${w}px;aspect-ratio:${ratio}"><img loading="lazy" alt="${esc(x.name || 'image')}"></div>`;
    }
    if (mime.startsWith('video/')) {
      return `<div class="att-vid" data-key="${esc(x.object_key)}" data-name="${esc(x.name || 'video')}"
        style="width:${w}px;aspect-ratio:${ratio}"><video playsinline webkit-playsinline preload="metadata"
        controls disablepictureinpicture x-webkit-airplay="deny"></video></div>`;
    }
    if (mime.startsWith('audio/')) {
      return `<div class="att-aud" data-key="${esc(x.object_key)}"><audio controls preload="metadata"></audio>
        <span class="muted">${esc(x.name || 'audio')}</span></div>`;
    }
    return `<div class="att-file" data-key="${esc(x.object_key)}" data-name="${esc(x.name || 'file')}">
      <span class="att-ico">📄</span><span>${esc(x.name || 'file')}</span>
      <span class="muted">${fmtSize(x.size || 0)}</span></div>`;
  }).join('') + '</div>';
}

export async function hydrateMedia(root) {
  const imgs = [...root.querySelectorAll('.att-img')];
  for (const box of imgs) {
    const url = await mediaUrl(box.dataset.key);
    if (!url) { box.classList.add('att-broken'); continue; }
    box.querySelector('img').src = url;
    box.onclick = () => openViewer(imgs.map((b) => ({
      key: b.dataset.key, name: b.dataset.name, kind: 'image',
    })), imgs.indexOf(box));
  }
  for (const box of root.querySelectorAll('.att-vid')) {
    const url = await mediaUrl(box.dataset.key);
    if (url) box.querySelector('video').src = url;
  }
  for (const box of root.querySelectorAll('.att-aud')) {
    const url = await mediaUrl(box.dataset.key);
    if (url) box.querySelector('audio').src = url;
  }
  for (const fc of root.querySelectorAll('.att-file')) {
    fc.onclick = async () => {
      const url = await mediaUrl(fc.dataset.key);
      if (url) saveBlob(url, fc.dataset.name);
      else toast('Could not open that file', 'error');
    };
  }
}

// In-app viewer with pan/zoom and keyboard nav. No navigation, no new tab, no
// external app: the whole point of the product's media promise.
export async function openViewer(items, startIndex = 0) {
  let i = startIndex;
  const lb = el('div', 'lightbox');
  lb.innerHTML = `
    <div class="lb-stage"><img alt=""></div>
    <div class="lb-bar">
      <button class="ghost" data-a="zoomout">−</button>
      <button class="ghost" data-a="zoomin">+</button>
      <button class="ghost" data-a="save">Save</button>
      <button class="ghost" data-a="close">✕</button>
    </div>
    <button class="lb-nav lb-prev" data-a="prev">‹</button>
    <button class="lb-nav lb-next" data-a="next">›</button>
    <div class="lb-count"></div>`;
  const img = lb.querySelector('img');
  const stage = lb.querySelector('.lb-stage');
  let scale = 1, tx = 0, ty = 0, dragging = false, sx = 0, sy = 0;

  const apply = () => { img.style.transform = `translate(${tx}px,${ty}px) scale(${scale})`; };
  const reset = () => { scale = 1; tx = 0; ty = 0; apply(); };

  async function show() {
    const it = items[i];
    lb.querySelector('.lb-count').textContent = items.length > 1 ? `${i + 1} / ${items.length}` : '';
    lb.querySelector('.lb-prev').style.display = items.length > 1 ? '' : 'none';
    lb.querySelector('.lb-next').style.display = items.length > 1 ? '' : 'none';
    reset();
    img.src = (await mediaUrl(it.key)) || '';
  }
  const close = () => { lb.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowRight' && items.length > 1) { i = (i + 1) % items.length; show(); }
    else if (e.key === 'ArrowLeft' && items.length > 1) { i = (i - 1 + items.length) % items.length; show(); }
    else if (e.key === '+' || e.key === '=') { scale = Math.min(6, scale * 1.3); apply(); }
    else if (e.key === '-') { scale = Math.max(1, scale / 1.3); if (scale === 1) { tx = ty = 0; } apply(); }
  };
  document.addEventListener('keydown', onKey);

  lb.onclick = (e) => {
    const a = e.target.dataset?.a;
    if (a === 'close' || e.target === lb || e.target === stage) return close();
    if (a === 'prev') { i = (i - 1 + items.length) % items.length; show(); }
    if (a === 'next') { i = (i + 1) % items.length; show(); }
    if (a === 'zoomin') { scale = Math.min(6, scale * 1.3); apply(); }
    if (a === 'zoomout') { scale = Math.max(1, scale / 1.3); if (scale === 1) { tx = ty = 0; } apply(); }
    if (a === 'save') mediaUrl(items[i].key).then((u) => u && saveBlob(u, items[i].name));
  };
  img.ondblclick = () => { scale = scale > 1 ? 1 : 2.5; tx = ty = 0; apply(); };
  img.onwheel = (e) => {
    e.preventDefault();
    scale = Math.max(1, Math.min(6, scale * (e.deltaY < 0 ? 1.12 : 0.89)));
    if (scale === 1) { tx = ty = 0; }
    apply();
  };
  img.onpointerdown = (e) => {
    if (scale <= 1) return;
    dragging = true; sx = e.clientX - tx; sy = e.clientY - ty;
    img.setPointerCapture(e.pointerId);
  };
  img.onpointermove = (e) => { if (dragging) { tx = e.clientX - sx; ty = e.clientY - sy; apply(); } };
  img.onpointerup = () => { dragging = false; };

  document.body.appendChild(lb);
  await show();
}

// Save without ever navigating away: fetch to a blob, then a synthetic download.
// On iOS where downloads are awkward, fall back to the native share sheet, which
// offers "Save Image" without leaving the app.
export async function saveBlob(url, name) {
  try {
    const blob = await (await fetch(url)).blob();
    const file = new File([blob], name || 'download', { type: blob.type });
    if (navigator.canShare?.({ files: [file] }) && /iPad|iPhone|iPod/.test(navigator.userAgent)) {
      await navigator.share({ files: [file] });
      return;
    }
    const u = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = u;
    a.download = name || 'download';
    a.click();
    setTimeout(() => URL.revokeObjectURL(u), 1000);
  } catch {
    toast('Save failed', 'error');
  }
}
