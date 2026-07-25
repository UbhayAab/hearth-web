// Voice channels: a WebRTC peer mesh with Supabase Realtime as the signalling
// bus. No SFU, no third-party service - for ambient rooms of a handful of people
// a mesh is the right call and it costs nothing.
import { sb, subscribe, unsubscribe, getSub } from '../sb.js';
import { api, table } from '../api.js';
import { store, bus, nameOf } from '../store.js';
import { $, el, esc } from '../util.js';
import { toast } from '../ui.js';
import { renderChannels } from './channels.js';

const RTC = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' },
  ],
};

export const voice = {
  active: false, channel: null, local: null, muted: false, deafened: false,
  peers: new Map(), monitors: new Map(), ptt: false, pttHeld: false, beat: null,
};

export async function joinVoice(channelId) {
  const c = store.channels.find((x) => x.id === channelId);
  if (!c) return;
  if (voice.active && voice.channel?.id === c.id) return;
  if (voice.active) await leaveVoice();

  try {
    voice.local = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
  } catch {
    toast('Microphone permission is needed to join voice', 'error');
    return;
  }

  voice.active = true;
  voice.channel = c;
  $('voicebar').classList.remove('hidden');
  $('vchanName').textContent = c.name;
  applyMicState();

  try { await api.joinVoice(c.id); } catch (e) { toast(e.message, 'error'); }

  subscribe('voice', 'vc:' + c.id, { signal: (p) => onSignal(p) }, { self: false });

  // Liveness. Without this the server cannot tell a closed laptop from a quiet
  // listener, and the room fills with people who are not there.
  clearInterval(voice.beat);
  voice.beat = setInterval(() => {
    if (voice.active && voice.channel) api.voiceHeartbeat(voice.channel.id).catch(() => {});
  }, 30000);

  const parts = await table('voice_participants', (q) => q.eq('channel_id', c.id));
  // Deterministic offerer (lower id offers) so two peers never both offer.
  for (const p of parts) if (p.user_id !== store.me && store.me < p.user_id) makePeer(p.user_id, true);
  await refreshVoice();
  monitorSelf();
}

function makePeer(peerId, initiator) {
  if (voice.peers.has(peerId)) return voice.peers.get(peerId);
  const pc = new RTCPeerConnection(RTC);
  voice.peers.set(peerId, pc);
  voice.local.getTracks().forEach((t) => pc.addTrack(t, voice.local));

  pc.onicecandidate = (e) => { if (e.candidate) signal(peerId, { kind: 'ice', data: e.candidate }); };
  pc.ontrack = (e) => {
    let a = document.getElementById('a-' + peerId);
    if (!a) {
      a = document.createElement('audio');
      a.id = 'a-' + peerId;
      a.autoplay = true;
      document.body.appendChild(a);
    }
    a.srcObject = e.streams[0];
    a.muted = voice.deafened;
    monitorSpeaking(peerId, e.streams[0]);
  };
  pc.onconnectionstatechange = () => {
    if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) dropPeer(peerId);
    refreshVoice();
  };
  if (initiator) {
    pc.createOffer()
      .then((o) => pc.setLocalDescription(o).then(() => signal(peerId, { kind: 'offer', data: o })))
      .catch(() => {});
  }
  return pc;
}

async function onSignal(p) {
  if (p.to !== store.me) return;
  const from = p.from;
  try {
    if (p.kind === 'offer') {
      const pc = makePeer(from, false);
      await pc.setRemoteDescription(p.data);
      const ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      signal(from, { kind: 'answer', data: ans });
    } else if (p.kind === 'answer') {
      await voice.peers.get(from)?.setRemoteDescription(p.data);
    } else if (p.kind === 'ice') {
      await voice.peers.get(from)?.addIceCandidate(p.data).catch(() => {});
    } else if (p.kind === 'bye') {
      dropPeer(from);
    }
  } catch (e) { console.warn('signal', e); }
}

function signal(to, msg) {
  getSub('voice')?.send({ type: 'broadcast', event: 'signal', payload: { from: store.me, to, ...msg } });
}

function dropPeer(id) {
  voice.peers.get(id)?.close();
  voice.peers.delete(id);
  document.getElementById('a-' + id)?.remove();
  const m = voice.monitors.get(id);
  if (m) { cancelAnimationFrame(m.raf); m.ctx?.close?.(); voice.monitors.delete(id); }
}

export async function leaveVoice() {
  if (!voice.active) return;
  const ch = voice.channel;
  for (const id of [...voice.peers.keys()]) { signal(id, { kind: 'bye' }); dropPeer(id); }
  clearInterval(voice.beat);
  voice.beat = null;
  unsubscribe('voice');
  voice.local?.getTracks().forEach((t) => t.stop());
  voice.local = null;
  voice.active = false;
  voice.channel = null;
  $('voicebar').classList.add('hidden');
  try { await api.leaveVoice(ch.id); } catch { /* best effort */ }
  await refreshVoice();
}

function applyMicState() {
  const on = voice.ptt ? voice.pttHeld : !voice.muted;
  voice.local?.getAudioTracks().forEach((t) => { t.enabled = on; });
  const b = $('vmute');
  if (b) {
    b.textContent = voice.ptt ? (voice.pttHeld ? '🎙 Live' : '🎙 Hold Space') : voice.muted ? '🔇 Unmute' : '🎤 Mute';
    b.classList.toggle('on', on);
  }
}

export async function refreshVoice() {
  const vids = store.channels.filter((c) => c.kind === 'voice').map((c) => c.id);
  if (vids.length) {
    const rows = await table('voice_participants', (q) => q.in('channel_id', vids));
    store.voiceParts = new Map();
    for (const r of rows) {
      if (!store.voiceParts.has(r.channel_id)) store.voiceParts.set(r.channel_id, []);
      store.voiceParts.get(r.channel_id).push(r.user_id);
    }
    renderChannels();
  }
  if (voice.active) {
    const ids = store.voiceParts.get(voice.channel.id) || [];
    $('vparts').innerHTML = ids.map((u) =>
      `<span class="vpart" id="vp-${esc(u)}">${esc(nameOf(u))}${u === store.me ? ' (you)' : ''}</span>`).join('');
    for (const u of ids) if (u !== store.me && !voice.peers.has(u) && store.me < u) makePeer(u, true);
  }
}

function monitorSpeaking(id, stream) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 256;
    src.connect(an);
    const buf = new Uint8Array(an.frequencyBinCount);
    const loop = () => {
      an.getByteFrequencyData(buf);
      const v = buf.reduce((a, b) => a + b, 0) / buf.length;
      document.getElementById('vp-' + id)?.classList.toggle('speaking', v > 18);
      const raf = requestAnimationFrame(loop);
      voice.monitors.set(id, { raf, ctx });
    };
    loop();
  } catch { /* analyser is a nicety */ }
}

function monitorSelf() {
  if (!voice.local) return;
  monitorSpeaking(store.me, voice.local);
}

export function initVoice() {
  $('vleave').onclick = leaveVoice;
  $('vmute').onclick = () => {
    if (voice.ptt) return;
    voice.muted = !voice.muted;
    applyMicState();
  };
  $('vdeafen').onclick = () => {
    voice.deafened = !voice.deafened;
    document.querySelectorAll('audio[id^="a-"]').forEach((a) => { a.muted = voice.deafened; });
    $('vdeafen').textContent = voice.deafened ? '🔇 Undeafen' : '🎧 Deafen';
    $('vdeafen').classList.toggle('on', !voice.deafened);
  };
  $('vptt').onclick = () => {
    voice.ptt = !voice.ptt;
    voice.pttHeld = false;
    $('vptt').classList.toggle('on', voice.ptt);
    $('vptt').textContent = voice.ptt ? 'PTT on' : 'PTT off';
    applyMicState();
    if (voice.ptt) toast('Push to talk: hold Space to speak');
  };

  // Push-to-talk: Space, but never while typing.
  const typing = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && voice.ptt && voice.active && !typing(e) && !voice.pttHeld) {
      e.preventDefault(); voice.pttHeld = true; applyMicState();
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space' && voice.ptt && voice.pttHeld) { voice.pttHeld = false; applyMicState(); }
  });

  // Leaving the tab open with a stale participant row is worse than a clean exit.
  window.addEventListener('pagehide', () => { if (voice.active) navigator.sendBeacon && leaveVoice(); });
  bus.on('voice:join', ({ channelId }) => joinVoice(channelId));
  bus.on('voice:refresh', refreshVoice);
  // The reaper evicts anyone who stopped heartbeating; tear down that peer
  // rather than holding a connection to a browser that is gone.
  bus.on('voice:left', ({ userId }) => { if (userId && userId !== store.me) dropPeer(userId); });
}
