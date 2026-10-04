import { create } from 'zustand';
import { api, auth } from './api.js';
import { kvGet, kvSet } from './db.js';
import { pinDigest } from './util.js';

let toastId = 0;

export const useApp = create((set, get) => ({
  ready: false,
  device: null, branch: null, settings: null, staff: null, branches: [],
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  socketConnected: false, outboxCount: 0, syncing: false, syncErrors: [],
  locked: false,
  notifications: [], toasts: [],

  toast(message, type = 'info', ms = 3500) {
    const id = ++toastId;
    set((s) => ({ toasts: [...s.toasts, { id, message, type }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ms);
  },
  setSettings(settings) { set({ settings }); applyTheme(settings); kvSet('settings', settings); },

  async loadDevice() {
    if (!auth.deviceToken) return null;
    try {
      const d = await api('/device/me');
      set({ device: d.device, branch: d.branch });
      get().setSettings(d.settings);
      kvSet('device', d);
      return d;
    } catch (e) {
      if (e.status === 401) { auth.deviceToken = null; return null; }
      const cached = await kvGet('device');
      if (cached) { set({ device: cached.device, branch: cached.branch }); get().setSettings(cached.settings); }
      return cached || null;
    }
  },

  async loadMe() {
    if (!auth.session) return null;
    try {
      const me = await api('/auth/me');
      set({ staff: { ...me.staff, perms: new Set(me.staff.permissions) }, branches: me.branches });
      get().setSettings(me.settings);
      if (!get().branch) set({ branch: me.branches.find((b) => b.id === me.staff.branchId) || me.branches[0] });
      kvSet('me', me);
      return me;
    } catch (e) {
      if (e.network) {
        const me = await kvGet('me');
        if (me) { set({ staff: { ...me.staff, perms: new Set(me.staff.permissions) }, branches: me.branches }); get().setSettings(me.settings); return me; }
      }
      if (e.status === 401) { auth.session = null; set({ staff: null }); }
      return null;
    }
  },

  async login(res, pin) {
    auth.session = res.token;
    // offline lock-screen unlock: keep a salted PBKDF2 digest of this staff's PIN on the device
    try { await kvSet(`pin:${res.staff.id}`, await pinDigest(pin, `${res.staff.id}:${res.staff.code}`)); } catch { /* ignore */ }
    set({ staff: { ...res.staff, perms: new Set(res.staff.permissions) }, locked: false });
    await get().loadMe();
  },
  async logout(remote = true) {
    if (remote && auth.session) { try { await api('/auth/logout', { method: 'POST', body: {} }); } catch { /* ignore */ } }
    auth.session = null;
    set({ staff: null, locked: false });
  },
  can(perm) { const p = get().staff?.perms; return !!p && (p.has('*') || p.has(perm)); },
}));

export const toast = (m, t, ms) => useApp.getState().toast(m, t, ms);
export const can = (perm) => useApp.getState().can(perm);

export function applyTheme(settings) {
  if (settings?.shop?.timezone) window.__shopTz = settings.shop.timezone;
  const t = settings?.shop?.theme;
  if (!t) return;
  const r = document.documentElement;
  if (t.primary) { r.style.setProperty('--primary', t.primary); r.style.setProperty('--primary-600', shade(t.primary, -12)); r.style.setProperty('--primary-50', mix(t.primary, t.mode === 'dark' ? '#1A1D21' : '#ffffff', 0.9)); }
  if (t.accent) r.style.setProperty('--accent', t.accent);
  if (t.radius != null) { r.style.setProperty('--radius', `${t.radius}px`); r.style.setProperty('--radius-sm', `${Math.max(4, t.radius - 4)}px`); }
  r.dataset.theme = t.mode === 'dark' ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t.primary);
  if (settings.shop?.name) document.title = settings.shop.name;
  if (settings.shop?.faviconUrl || settings.shop?.logoUrl) {
    const link = document.querySelector('link[rel="icon"]');
    if (link) link.href = settings.shop.faviconUrl || settings.shop.logoUrl;
  }
}

function hexToRgb(h) { const x = h.replace('#', ''); const n = parseInt(x.length === 3 ? x.split('').map((c) => c + c).join('') : x, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
const toHex = (rgb) => '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
function shade(hex, pct) { try { return toHex(hexToRgb(hex).map((v) => v + (v * pct) / 100)); } catch { return hex; } }
function mix(a, b, w) { try { const x = hexToRgb(a); const y = hexToRgb(b); return toHex(x.map((v, i) => v * (1 - w) + y[i] * w)); } catch { return a; } }
