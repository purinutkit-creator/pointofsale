import { useEffect, useMemo, useRef, useState, createContext, useContext, useCallback, useId } from 'react';
import { createPortal } from 'react-dom';
import Icon from './Icon.jsx';
import { useApp } from '../lib/store.js';
import { cls } from '../lib/util.js';
import { api, setApprovalHandler, approvalLabel } from '../lib/api.js';

export { Icon };

export function Button({ variant, size, block, icon, loading, children, className, ...p }) {
  return (
    <button className={cls('btn', variant, size, block && 'block', !children && icon && 'icon', className)} disabled={loading || p.disabled} {...p}>
      {loading ? <span className="spinner" style={{ width: 18, height: 18, borderWidth: 2 }} /> : icon && <Icon name={icon} size={size === 'sm' ? 16 : 20} />}
      {children}
    </button>
  );
}

export function Modal({ title, onClose, children, footer, size, closeOnBg = true, icon }) {
  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return createPortal(
    <div className="modal-bg" onMouseDown={(e) => { if (closeOnBg && e.target === e.currentTarget) onClose?.(); }}>
      <div className={cls('modal', size)} role="dialog" aria-modal="true">
        {title !== undefined && (
          <div className="modal-h">
            {icon && <Icon name={icon} />}
            <h3>{title}</h3>
            {onClose && <Button variant="ghost" icon="x" onClick={onClose} aria-label="ปิด" />}
          </div>
        )}
        <div className="modal-b">{children}</div>
        {footer && <div className="modal-f">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Field({ label, hint, children, className, style, htmlFor }) {
  return (
    <div className={cls('field', className)} style={style}>
      {label && <label htmlFor={htmlFor}>{label}</label>}
      {children}
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

export function Input({ label, hint, className, size, onValue, ...p }) {
  const auto = useId();
  const id = p.id || auto;
  const el = <input id={id} className={cls('input', size, className)} {...p} onChange={(e) => { p.onChange?.(e); onValue?.(p.type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value); }} />;
  return label || hint ? <Field label={label} hint={hint} htmlFor={id}>{el}</Field> : el;
}
export function TextArea({ label, hint, onValue, ...p }) {
  const id = useId();
  const el = <textarea id={id} className="input" {...p} onChange={(e) => { p.onChange?.(e); onValue?.(e.target.value); }} />;
  return label ? <Field label={label} hint={hint} htmlFor={id}>{el}</Field> : el;
}
export function Select({ label, hint, options, onValue, placeholder, ...p }) {
  const id = useId();
  const el = (
    <select id={id} className="input" {...p} onChange={(e) => { p.onChange?.(e); onValue?.(e.target.value); }}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o) => (typeof o === 'object' ? <option key={o.value} value={o.value}>{o.label}</option> : <option key={o} value={o}>{o}</option>))}
    </select>
  );
  return label ? <Field label={label} hint={hint} htmlFor={id}>{el}</Field> : el;
}
export function Toggle({ checked, onChange, disabled, label, hint }) {
  const t = (
    <label className="toggle">
      <input type="checkbox" checked={!!checked} disabled={disabled} onChange={(e) => onChange?.(e.target.checked)} />
      <span />
    </label>
  );
  if (!label) return t;
  return (
    <div className="row between" style={{ minHeight: 44 }}>
      <div className="grow"><div style={{ fontWeight: 600 }}>{label}</div>{hint && <div className="xs muted">{hint}</div>}</div>
      {t}
    </div>
  );
}
export function Check({ checked, onChange, label, disabled }) {
  return <label className="check"><input type="checkbox" checked={!!checked} disabled={disabled} onChange={(e) => onChange?.(e.target.checked)} /> <span>{label}</span></label>;
}
export function Seg({ value, onChange, options, size }) {
  return (
    <div className={cls('seg', size)}>
      {options.map((o) => {
        const v = typeof o === 'object' ? o.value : o;
        return <button type="button" key={String(v)} className={value === v ? 'on' : ''} onClick={() => onChange(v)}>{typeof o === 'object' ? o.label : o}</button>;
      })}
    </div>
  );
}
export const Badge = ({ tone, children, style }) => <span className={cls('badge', tone)} style={style}>{children}</span>;
export const Spinner = ({ size = 22 }) => <span className="spinner" style={{ width: size, height: size }} />;
export const Empty = ({ icon = 'box', children }) => <div className="empty"><Icon name={icon} size={36} /><div className="mt">{children}</div></div>;
export const Loading = () => <div className="fullcenter"><Spinner size={32} /></div>;

export function NumPad({ onKey, extra = '.', className }) {
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', extra, '0', '⌫'];
  return (
    <div className={cls('numpad', className)}>
      {keys.map((k, i) => (k ? <button type="button" key={i} onClick={() => onKey(k)}>{k}</button> : <span key={i} />))}
    </div>
  );
}
export function applyKey(value, k, { maxLen = 12, decimals = 2 } = {}) {
  let v = String(value ?? '');
  if (k === '⌫') return v.slice(0, -1);
  if (k === 'C') return '';
  if (k === '.') return v.includes('.') || !decimals ? v : (v || '0') + '.';
  if (v.includes('.') && v.split('.')[1].length >= decimals) return v;
  if (v.length >= maxLen) return v;
  return v === '0' ? k : v + k;
}

export function PinPad({ length = 6, min = 4, onSubmit, busy, error }) {
  const [pin, setPin] = useState('');
  useEffect(() => { if (error) setPin(''); }, [error]);
  useEffect(() => {
    const h = (e) => {
      if (/^\d$/.test(e.key)) setPin((p) => (p.length < length ? p + e.key : p));
      else if (e.key === 'Backspace') setPin((p) => p.slice(0, -1));
      else if (e.key === 'Enter') setPin((p) => { if (p.length >= min) onSubmit(p); return p; });
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [length, min, onSubmit]);
  const press = (k) => {
    if (k === '⌫') return setPin((p) => p.slice(0, -1));
    if (k === '✓') { if (pin.length >= min) onSubmit(pin); return; }
    const next = pin.length < length ? pin + k : pin;
    setPin(next);
    if (next.length === length) onSubmit(next);
  };
  return (
    <div>
      <div className="pin-dots">{Array.from({ length }, (_, i) => <span key={i} className={i < pin.length ? 'on' : ''} style={i >= min && i >= pin.length ? { opacity: .35 } : undefined} />)}</div>
      {error && <div className="center" style={{ color: 'var(--danger)', fontWeight: 600, marginBottom: 10 }}>{error}</div>}
      <div className="numpad">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', '✓'].map((k) => (
          <button type="button" key={k} disabled={busy} onClick={() => press(k)} style={k === '✓' ? { background: 'var(--primary)', color: '#fff', borderColor: 'var(--primary)' } : undefined}>
            {k === '✓' && busy ? <Spinner /> : k}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  return createPortal(<div className="toasts">{toasts.map((t) => <div key={t.id} className={cls('toast', t.type)}><Icon name={t.type === 'error' ? 'alert' : t.type === 'success' ? 'check' : 'info'} />{t.message}</div>)}</div>, document.body);
}

// ── Confirm / Prompt dialogs (promise based) ──────────────────────────────
const DialogCtx = createContext(null);
export function DialogProvider({ children }) {
  const [dlg, setDlg] = useState(null);
  const confirm = useCallback((opts) => new Promise((resolve) => setDlg({ kind: 'confirm', ...(typeof opts === 'string' ? { message: opts } : opts), resolve })), []);
  const prompt = useCallback((opts) => new Promise((resolve) => setDlg({ kind: 'prompt', value: opts.value || '', ...opts, resolve })), []);
  const close = (v) => { dlg?.resolve(v); setDlg(null); };
  return (
    <DialogCtx.Provider value={{ confirm, prompt }}>
      {children}
      {dlg && (
        <Modal title={dlg.title || (dlg.kind === 'confirm' ? 'ยืนยัน' : 'กรอกข้อมูล')} size="narrow" onClose={() => close(dlg.kind === 'confirm' ? false : null)}
          footer={<><Button onClick={() => close(dlg.kind === 'confirm' ? false : null)}>ยกเลิก</Button>
            <Button variant={dlg.danger ? 'danger' : 'primary'} onClick={() => close(dlg.kind === 'confirm' ? true : dlg.value)} disabled={dlg.kind === 'prompt' && dlg.required && !String(dlg.value).trim()}>{dlg.okText || 'ยืนยัน'}</Button></>}>
          {dlg.message && <p style={{ marginTop: 0, whiteSpace: 'pre-line' }}>{dlg.message}</p>}
          {dlg.kind === 'prompt' && (
            <div className="col">
              {dlg.options && <div className="row wrap">{dlg.options.map((o) => <button key={o} type="button" className={cls('chip', dlg.value === o && 'on')} onClick={() => setDlg({ ...dlg, value: o })}>{o}</button>)}</div>}
              {dlg.multiline ? <TextArea autoFocus value={dlg.value} placeholder={dlg.placeholder} onValue={(v) => setDlg({ ...dlg, value: v })} />
                : <Input autoFocus type={dlg.type || 'text'} value={dlg.value} placeholder={dlg.placeholder} onValue={(v) => setDlg({ ...dlg, value: v })} onKeyDown={(e) => { if (e.key === 'Enter') close(dlg.value); }} />}
            </div>
          )}
        </Modal>
      )}
    </DialogCtx.Provider>
  );
}
export const useDialog = () => useContext(DialogCtx);

// ── Manager Approval (global): any API call answered with APPROVAL_REQUIRED opens this ──
export function ApprovalProvider() {
  const [req, setReq] = useState(null);
  const [code, setCode] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    setApprovalHandler((info) => new Promise((resolve) => { setCode(''); setReason(''); setError(''); setReq({ ...info, resolve }); }));
    return () => setApprovalHandler(null);
  }, []);
  if (!req) return null;
  const submit = async (pin) => {
    if (!code) { setError('กรุณากรอกรหัสผู้อนุมัติ'); return; }
    setBusy(true); setError('');
    try {
      const r = await api('/approvals', { method: 'POST', body: { action: req.action, employeeCode: code.trim(), pin, orderId: req.orderId || null, reason: reason || null } });
      useApp.getState().toast(`อนุมัติโดย ${r.approver.name}`, 'success');
      req.resolve(r.token); setReq(null);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  return (
    <Modal title="ต้องการการอนุมัติ (Manager PIN)" icon="shield" size="narrow" onClose={() => { req.resolve(null); setReq(null); }}>
      <div className="col">
        <div className="card pad" style={{ background: 'var(--warning-50)', borderColor: 'transparent' }}>
          <div className="bold">{approvalLabel(req.action)}</div>
          <div className="small muted">{req.message}</div>
        </div>
        <Input label="รหัสพนักงานผู้อนุมัติ" value={code} onValue={setCode} placeholder="เช่น EMP001" autoFocus />
        <Input label="เหตุผล (ไม่บังคับ)" value={reason} onValue={setReason} />
        <div className="label">PIN ผู้อนุมัติ</div>
        <PinPad onSubmit={submit} busy={busy} error={error} />
      </div>
    </Modal>
  );
}

// ── Data table with search ────────────────────────────────────────────────
export function DataTable({ columns, rows, onRow, search = true, empty = 'ไม่มีข้อมูล', footer, initialSort, pageSize = 100, toolbar }) {
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(pageSize);
  const [sort, setSort] = useState(initialSort || null);
  const filtered = useMemo(() => {
    let list = rows || [];
    if (q) { const s = q.toLowerCase(); list = list.filter((r) => columns.some((c) => String(c.text ? c.text(r) : r[c.key] ?? '').toLowerCase().includes(s))); }
    if (sort) {
      const c = columns.find((x) => x.key === sort.key);
      const val = (r) => (c?.sortValue ? c.sortValue(r) : r[sort.key]);
      list = [...list].sort((a, b) => { const x = val(a); const y = val(b); return (x > y ? 1 : x < y ? -1 : 0) * (sort.dir === 'desc' ? -1 : 1); });
    }
    return list;
  }, [rows, q, sort, columns]);
  return (
    <div className="col">
      {(search || toolbar) && (
        <div className="row wrap">
          {search && <div style={{ position: 'relative', flex: '1 1 240px', maxWidth: 360 }}><Icon name="search" style={{ position: 'absolute', left: 12, top: 12, color: 'var(--muted)' }} /><input className="input" style={{ paddingLeft: 40 }} placeholder="ค้นหา…" value={q} onChange={(e) => setQ(e.target.value)} /></div>}
          <div className="grow" />
          {toolbar}
        </div>
      )}
      <div className="table-wrap">
        <table className="t">
          <thead><tr>{columns.map((c) => <th key={c.key} className={c.num ? 'num' : ''} style={{ width: c.width, cursor: 'pointer' }} onClick={() => setSort((s) => ({ key: c.key, dir: s?.key === c.key && s.dir === 'asc' ? 'desc' : 'asc' }))}>{c.label}{sort?.key === c.key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}</th>)}</tr></thead>
          <tbody>
            {filtered.slice(0, limit).map((r, i) => (
              <tr key={r.id ?? i} className={onRow ? 'click' : ''} onClick={() => onRow?.(r)}>
                {columns.map((c) => <td key={c.key} className={c.num ? 'num' : ''}>{c.render ? c.render(r) : r[c.key]}</td>)}
              </tr>
            ))}
            {!filtered.length && <tr><td colSpan={columns.length}><div className="empty">{empty}</div></td></tr>}
          </tbody>
          {footer && <tfoot><tr>{columns.map((c) => <td key={c.key} className={c.num ? 'num' : ''}>{footer[c.key] ?? ''}</td>)}</tr></tfoot>}
        </table>
      </div>
      {filtered.length > limit && <Button onClick={() => setLimit(limit + pageSize)}>แสดงเพิ่ม ({filtered.length - limit})</Button>}
    </div>
  );
}

/** useAsync: load data with loading/error state and reload(). */
export function useAsync(fn, deps = []) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const fnRef = useRef(fn); fnRef.current = fn;
  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true }));
    try { const data = await fnRef.current(); setState({ loading: false, data, error: null }); return data; } catch (error) { setState({ loading: false, data: null, error }); return null; }
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, deps);
  return { ...state, reload: load, setData: (d) => setState((s) => ({ ...s, data: typeof d === 'function' ? d(s.data) : d })) };
}

export function ErrorBox({ error, onRetry }) {
  if (!error) return null;
  return <div className="card pad" style={{ borderColor: 'var(--danger)', background: 'var(--danger-50)' }}><div className="row"><Icon name="alert" /><div className="grow">{error.message}</div>{onRetry && <Button size="sm" onClick={onRetry}>ลองใหม่</Button>}</div></div>;
}

export function Money({ v, symbol = '฿', className }) {
  return <span className={cls('num', className)}>{symbol}{Number(v || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>;
}
