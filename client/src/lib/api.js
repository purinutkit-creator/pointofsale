// API client: device token + staff session + branch header, transparent Manager Approval retry.
const LS = typeof localStorage !== 'undefined' ? localStorage : { getItem: () => null, setItem() {}, removeItem() {} };

export const auth = {
  get deviceToken() { return LS.getItem('pos.deviceToken'); },
  set deviceToken(v) { v ? LS.setItem('pos.deviceToken', v) : LS.removeItem('pos.deviceToken'); },
  get session() { return LS.getItem('pos.session'); },
  set session(v) { v ? LS.setItem('pos.session', v) : LS.removeItem('pos.session'); },
  get branchId() { return LS.getItem('pos.branchId'); },
  set branchId(v) { v ? LS.setItem('pos.branchId', String(v)) : LS.removeItem('pos.branchId'); },
  get memberToken() { return LS.getItem('pos.memberToken'); },
  set memberToken(v) { v ? LS.setItem('pos.memberToken', v) : LS.removeItem('pos.memberToken'); },
};

export class ApiError extends Error {
  constructor(status, data) {
    super(data?.error || `HTTP ${status}`);
    this.status = status; this.code = data?.code; this.data = data;
  }
}
export class NetworkError extends Error {
  constructor(e) { super('ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้'); this.cause = e; this.network = true; }
}

let approvalHandler = null;
let sessionExpiredHandler = null;
export const setApprovalHandler = (fn) => { approvalHandler = fn; };
export const setSessionExpiredHandler = (fn) => { sessionExpiredHandler = fn; };

const ACTION_LABEL = {
  void_item: 'Void รายการ', void_order: 'Void Order', refund: 'คืนเงิน (Refund)', discount_over_limit: 'ส่วนลดเกินสิทธิ์',
  override_price: 'เปลี่ยนราคา (Override Price)', reprint: 'พิมพ์ใบเสร็จซ้ำ', open_drawer: 'เปิดลิ้นชักเงินสด', cash_out: 'นำเงินออก (Cash Out)',
  edit_closed_bill: 'แก้ไขบิลที่ปิดแล้ว', sc_exempt: 'ยกเว้น Service Charge',
};
export const approvalLabel = (a) => ACTION_LABEL[a] || a;

export async function api(path, { method = 'GET', body, headers = {}, member = false, raw = false, signal, approvalToken } = {}) {
  const h = { ...headers };
  if (body !== undefined && !(body instanceof FormData)) h['Content-Type'] = 'application/json';
  if (auth.deviceToken) h['X-Device-Token'] = auth.deviceToken;
  if (member) { if (auth.memberToken) h.Authorization = `Bearer ${auth.memberToken}`; } else if (auth.session) h.Authorization = `Bearer ${auth.session}`;
  if (!member && auth.branchId) h['X-Branch-Id'] = auth.branchId;
  if (approvalToken) h['X-Approval-Token'] = approvalToken;
  let res;
  try {
    res = await fetch(`/api${path}`, { method, headers: h, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body), signal });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new NetworkError(e);
  }
  if (raw && res.ok) return res;
  const isJson = res.headers.get('content-type')?.includes('application/json');
  const data = isJson ? await res.json() : await res.text();
  if (res.ok) return data;
  const err = new ApiError(res.status, isJson ? data : { error: data });
  if (res.status === 403 && err.code === 'APPROVAL_REQUIRED' && approvalHandler && !approvalToken) {
    const token = await approvalHandler({ action: data.action, perm: data.perm, message: data.error, orderId: body?.orderId });
    if (token) return api(path, { method, body, headers, member, raw, signal, approvalToken: token });
    const cancelled = new ApiError(403, { error: 'ยกเลิกการอนุมัติ', code: 'APPROVAL_CANCELLED' });
    throw cancelled;
  }
  if (res.status === 401 && !member && ['SESSION_EXPIRED', 'SESSION_IDLE', 'LOGIN_REQUIRED'].includes(err.code)) sessionExpiredHandler?.(err);
  throw err;
}

export const get = (p, o) => api(p, o);
export const post = (p, body, o) => api(p, { ...o, method: 'POST', body: body ?? {} });
export const put = (p, body, o) => api(p, { ...o, method: 'PUT', body: body ?? {} });
export const del = (p, o) => api(p, { ...o, method: 'DELETE' });

/** Download a file endpoint (CSV/XLSX/PDF/backup) with auth headers. */
export async function download(path, filename) {
  const res = await api(path, { raw: true });
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename || res.headers.get('content-disposition')?.match(/filename="(.+)"/)?.[1] || 'download';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16); }));
