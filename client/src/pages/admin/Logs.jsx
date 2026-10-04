// Activity Log, Manager Approval log, Shift history
import { useState } from 'react';
import { api } from '../../lib/api.js';
import { useApp } from '../../lib/store.js';
import { Page } from './Admin.jsx';
import { DataTable, useAsync, Input, Badge, Modal, Spinner, Button } from '../../components/ui.jsx';
import { fmtDateTime, money, PAYMENT_METHOD_LABEL, daysAgo, today } from '../../lib/util.js';
import { approvalLabel } from '../../lib/api.js';

export default function Logs({ tab: initial }) {
  const can = useApp((s) => s.can);
  const [tab, setTab] = useState(initial || (can('audit.view') ? 'audit' : 'shifts'));
  const tabs = [...(can('audit.view') ? [{ value: 'audit', label: 'Activity Log' }, { value: 'approvals', label: 'Manager Approval' }] : []), { value: 'shifts', label: 'กะ (Shift)' }];
  return (
    <Page title={tab === 'shifts' ? 'กะการขาย' : 'Activity Log'} tabs={tabs} tab={tab} onTab={setTab}>
      {tab === 'audit' && <Audit />}
      {tab === 'approvals' && <Approvals />}
      {tab === 'shifts' && <Shifts />}
    </Page>
  );
}

function Audit() {
  const [f, setF] = useState({ from: daysAgo(7), to: today(), action: '', q: '' });
  const list = useAsync(() => api(`/audit-logs?from=${f.from}&to=${f.to}&action=${encodeURIComponent(f.action)}&q=${encodeURIComponent(f.q)}`), [f.from, f.to, f.action]);
  return (
    <div className="col">
      <div className="row wrap">
        <Input type="date" value={f.from} onValue={(v) => setF({ ...f, from: v })} style={{ maxWidth: 170 }} />
        <Input type="date" value={f.to} onValue={(v) => setF({ ...f, to: v })} style={{ maxWidth: 170 }} />
        {['', 'auth', 'shift', 'order', 'payment', 'discount', 'void', 'refund', 'receipt.reprint', 'drawer', 'cash', 'stock', 'member.points', 'settings', 'staff'].map((a) => <button key={a} type="button" className={`chip ${f.action === a ? 'on' : ''}`} onClick={() => setF({ ...f, action: a })}>{a || 'ทั้งหมด'}</button>)}
      </div>
      <DataTable rows={list.data || []} columns={[
        { key: 'created_at', label: 'เวลา', render: (a) => fmtDateTime(a.created_at) }, { key: 'action', label: 'Action', render: (a) => <Badge tone={/void|refund|failed|delete/.test(a.action) ? 'danger' : /login|open/.test(a.action) ? 'info' : ''}>{a.action}</Badge> },
        { key: 'staff', label: 'ผู้ทำ', render: (a) => (a.staff_code ? `${a.staff_code} ${a.staff_name}` : '-') }, { key: 'approver_code', label: 'ผู้อนุมัติ' },
        { key: 'entity', label: 'อ้างอิง', render: (a) => (a.entity ? `${a.entity} ${a.entity_id || ''}` : '') }, { key: 'details', label: 'รายละเอียด' },
        { key: 'device_name', label: 'อุปกรณ์' }, { key: 'branch_name', label: 'สาขา' }, { key: 'ip', label: 'IP' },
      ]} />
    </div>
  );
}

function Approvals() {
  const list = useAsync(() => api('/approvals'));
  return <DataTable rows={list.data || []} columns={[{ key: 'created_at', label: 'เวลา', render: (a) => fmtDateTime(a.created_at) }, { key: 'action', label: 'รายการ', render: (a) => approvalLabel(a.action) }, { key: 'req', label: 'ผู้ทำ', render: (a) => `${a.requested_by_code} ${a.requested_by_name}` }, { key: 'ap', label: 'ผู้อนุมัติ', render: (a) => `${a.approved_by_code} ${a.approved_by_name}` }, { key: 'order_no', label: 'Order', render: (a) => (a.order_no ? `#${a.order_no}` : '-') }, { key: 'reason', label: 'เหตุผล' }, { key: 'used_at', label: 'ใช้แล้ว', render: (a) => (a.used_at ? '✓' : 'ไม่ได้ใช้') }]} />;
}

function Shifts() {
  const list = useAsync(() => api('/shifts'));
  const [open, setOpen] = useState(null);
  const d = useAsync(() => (open ? api(`/shifts/${open}`) : null), [open]);
  return (
    <div className="col">
      <DataTable rows={list.data || []} onRow={(s) => setOpen(s.id)} columns={[{ key: 'opened_at', label: 'เปิดกะ', render: (s) => fmtDateTime(s.opened_at) }, { key: 'closed_at', label: 'ปิดกะ', render: (s) => (s.closed_at ? fmtDateTime(s.closed_at) : '-') }, { key: 'staff', label: 'พนักงาน', render: (s) => `${s.employee_code} ${s.staff_name}` }, { key: 'device_name', label: 'เครื่อง' }, { key: 'opening_cash', label: 'Opening', num: true, render: (s) => money(s.opening_cash) }, { key: 'expected_cash', label: 'Expected', num: true, render: (s) => (s.expected_cash != null ? money(s.expected_cash) : '-') }, { key: 'actual_cash', label: 'Actual', num: true, render: (s) => (s.actual_cash != null ? money(s.actual_cash) : '-') }, { key: 'difference', label: 'Over/Short', num: true, render: (s) => (s.difference != null ? <span style={{ color: s.difference === 0 ? 'var(--success)' : 'var(--danger)' }}>{money(s.difference)}</span> : '-') }, { key: 'status', label: 'สถานะ', render: (s) => <Badge tone={s.status === 'open' ? 'warning' : 'success'}>{s.status === 'open' ? 'เปิดอยู่' : 'ปิดแล้ว'}</Badge> }]} />
      {open && (
        <Modal title="รายละเอียดกะ" onClose={() => setOpen(null)} footer={<Button icon="print" onClick={() => api(`/shifts/${open}/print`, { method: 'POST', body: {} })}>พิมพ์ Shift Report</Button>}>
          {!d.data ? <Spinner /> : (
            <div className="col gap-s">
              {[['บิล', d.data.orders], ['Gross', money(d.data.grossSales)], ['Discount', money(d.data.discount)], ['Net', money(d.data.netSales)], ['Refund', money(d.data.refunds)], ...d.data.payments.map((p) => [PAYMENT_METHOD_LABEL[p.method], money(p.amount)]), ['Opening Cash', money(d.data.openingCash)], ['Cash Sales', money(d.data.cashSales)], ['Cash In', money(d.data.cashIn)], ['Cash Out', money(d.data.cashOut)], ['Cash Refund', money(d.data.cashRefunds)], ['Expected Cash', money(d.data.expectedCash)], ['Actual Cash', d.data.actualCash != null ? money(d.data.actualCash) : '-'], ['Difference', d.data.difference != null ? money(d.data.difference) : '-'], ['เปิดลิ้นชัก No Sale', d.data.noSaleCount]].map(([k, v]) => <div key={k} className="row between"><span>{k}</span><b className="num">{v}</b></div>)}
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
