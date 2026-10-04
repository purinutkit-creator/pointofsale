import { useEffect, useState, useCallback } from 'react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, LineChart, Line, Legend } from 'recharts';
import { api } from '../../lib/api.js';
import { on } from '../../lib/socket.js';
import { useApp } from '../../lib/store.js';
import { Page } from './Admin.jsx';
import { Seg, Input, ErrorBox, Spinner, Money, Badge } from '../../components/ui.jsx';
import { money, int, today, daysAgo } from '../../lib/util.js';

// Reference palette (dataviz): categorical slot 1/2, recessive grid
export const VIZ = { s1: '#2a78d6', s2: '#eb6834', grid: 'var(--border)', ink: 'var(--muted)' };
const tip = { contentStyle: { borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontFamily: 'Sarabun' }, cursor: { fill: 'rgba(127,127,127,.08)' } };
const axis = { tick: { fill: 'var(--muted)', fontSize: 12, fontFamily: 'Sarabun' }, axisLine: false, tickLine: false };

export function RangePicker({ value, onChange, allowAll }) {
  const can = useApp((s) => s.can);
  const preset = (k) => {
    const map = { today: [today(), today()], yesterday: [daysAgo(1), daysAgo(1)], d7: [daysAgo(6), today()], d30: [daysAgo(29), today()], month: [today().slice(0, 8) + '01', today()] };
    onChange({ ...value, from: map[k][0], to: map[k][1], preset: k });
  };
  return (
    <div className="row wrap">
      <Seg value={value.preset} onChange={preset} options={[{ value: 'today', label: 'วันนี้' }, { value: 'yesterday', label: 'เมื่อวาน' }, { value: 'd7', label: '7 วัน' }, { value: 'd30', label: '30 วัน' }, { value: 'month', label: 'เดือนนี้' }]} />
      <Input type="date" value={value.from} onValue={(v) => onChange({ ...value, from: v, preset: null })} style={{ width: 160 }} />
      <Input type="date" value={value.to} onValue={(v) => onChange({ ...value, to: v, preset: null })} style={{ width: 160 }} />
      {allowAll && can('report.all_branches') && <Seg value={value.branch} onChange={(b) => onChange({ ...value, branch: b })} options={[{ value: 'current', label: 'สาขานี้' }, { value: 'all', label: 'ทุกสาขา' }]} />}
    </div>
  );
}

export function Kpi({ label, value, sub, tone }) {
  return <div className="card kpi"><div className="l">{label}</div><div className="v" style={tone ? { color: `var(--${tone})` } : undefined}>{value}</div>{sub && <div className="xs muted">{sub}</div>}</div>;
}

export default function Dashboard() {
  const [range, setRange] = useState({ from: today(), to: today(), preset: 'today', branch: 'current' });
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const load = useCallback(() => api(`/dashboard?from=${range.from}&to=${range.to}${range.branch === 'all' ? '&branchId=all' : ''}`).then((x) => { setD(x); setErr(null); }).catch(setErr), [range]);
  useEffect(() => { load(); const off = on('sales:changed', load); const t = setInterval(load, 60000); return () => { off(); clearInterval(t); }; }, [load]);
  const k = d?.kpi;
  return (
    <Page title="Dashboard" actions={<RangePicker value={range} onChange={setRange} allowAll />}>
      <ErrorBox error={err} onRetry={load} />
      {!d ? <div className="center"><Spinner /></div> : (
        <div className="col gap-l">
          <div className="grid-4">
            <Kpi label="Gross Sales" value={<Money v={k.grossSales} />} />
            <Kpi label="Net Sales" value={<Money v={k.netSales} />} sub="หลังหักส่วนลดและคืนเงิน" />
            <Kpi label="Orders" value={int(k.orders)} sub={`Customers ${int(k.customers)} · สมาชิก ${int(k.members)}`} />
            <Kpi label="Average Bill" value={<Money v={k.averageBill} />} />
            <Kpi label="Discount" value={<Money v={k.discount} />} />
            <Kpi label="Refund" value={<Money v={k.refund} />} tone={k.refund ? 'danger' : undefined} />
            <Kpi label="VAT" value={<Money v={k.vat} />} />
            <Kpi label="Service Charge" value={<Money v={k.serviceCharge} />} />
            {k.profit != null && <Kpi label="กำไรขั้นต้น (ประมาณ)" value={<Money v={k.profit} />} sub={`ต้นทุน ${money(k.cost)}`} />}
            <Kpi label="Void" value={int(k.voids)} sub={`มูลค่า ${money(k.voidAmount)}`} />
            <Kpi label="บิลเปิดอยู่" value={int(k.openOrders)} sub={`ยอด ${money(k.openAmount)}`} />
          </div>
          <div className="grid-2">
            <div className="card">
              <div className="card-h"><b>ยอดขายรายชั่วโมง (Sales by Hour)</b></div>
              <div className="card-b" style={{ height: 260 }}>
                <ResponsiveContainer><BarChart data={d.hours.filter((h) => h.hour >= 6 || h.amount)} barCategoryGap={3}>
                  <CartesianGrid vertical={false} stroke={VIZ.grid} /><XAxis dataKey="hour" {...axis} tickFormatter={(h) => `${h}:00`} /><YAxis {...axis} width={60} tickFormatter={(v) => int(v)} />
                  <Tooltip {...tip} formatter={(v, n) => [n === 'amount' ? `฿${money(v)}` : v, n === 'amount' ? 'ยอดขาย' : 'บิล']} labelFormatter={(h) => `${h}:00–${h}:59`} />
                  <Bar dataKey="amount" fill={VIZ.s1} radius={[4, 4, 0, 0]} />
                </BarChart></ResponsiveContainer>
              </div>
            </div>
            <div className="card">
              <div className="card-h"><b>ยอดขายรายวัน</b></div>
              <div className="card-b" style={{ height: 260 }}>
                <ResponsiveContainer><LineChart data={d.daily}>
                  <CartesianGrid vertical={false} stroke={VIZ.grid} /><XAxis dataKey="day" {...axis} tickFormatter={(x) => x.slice(5)} /><YAxis {...axis} width={60} tickFormatter={(v) => int(v)} />
                  <Tooltip {...tip} formatter={(v) => [`฿${money(v)}`, 'ยอดขาย']} />
                  <Line dataKey="amount" stroke={VIZ.s1} strokeWidth={2} dot={{ r: 4 }} activeDot={{ r: 6 }} />
                </LineChart></ResponsiveContainer>
              </div>
            </div>
          </div>
          <div className="grid-3">
            <BarList title="ช่องทางชำระเงิน" rows={d.payments.map((p) => ({ label: p.label, value: p.amount, sub: `${p.n} บิล` }))} />
            <BarList title="ยอดขายตามหมวด (Category)" rows={d.categories.map((c) => ({ label: c.name, value: c.amount, sub: `${int(c.qty)} ชิ้น` }))} />
            <BarList title="สินค้าขายดี (Best Sellers)" rows={d.bestSellers.map((b) => ({ label: b.name, value: b.qty, sub: `฿${money(b.amount)}` }))} unit="ชิ้น" />
          </div>
          <div className="grid-2">
            <BarList title="ยอดขายพนักงาน (Staff Sales)" rows={d.staff.map((s) => ({ label: `${s.code || ''} ${s.name || ''}`, value: s.amount, sub: `${s.orders} บิล` }))} />
            {d.branches.length > 0 && <BarList title="ยอดขายตามสาขา" rows={d.branches.map((b) => ({ label: b.name, value: b.amount, sub: `${b.orders} บิล` }))} />}
          </div>
        </div>
      )}
    </Page>
  );
}

/** Ranked horizontal bars (single hue, direct labels in text ink, hover title) */
export function BarList({ title, rows, unit }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="card">
      <div className="card-h"><b>{title}</b></div>
      <div className="card-b col gap-s">
        {!rows.length && <div className="muted small">ไม่มีข้อมูล</div>}
        {rows.map((r, i) => (
          <div key={i} title={`${r.label}: ${unit ? `${int(r.value)} ${unit}` : `฿${money(r.value)}`}${r.sub ? ` · ${r.sub}` : ''}`}>
            <div className="row between small"><span className="ellipsis">{r.label}</span><b className="num">{unit ? `${int(r.value)} ${unit}` : money(r.value)}</b></div>
            <div style={{ height: 8, background: 'var(--surface-2)', borderRadius: 4 }}><div style={{ width: `${(r.value / max) * 100}%`, height: '100%', background: VIZ.s1, borderRadius: 4 }} /></div>
            {r.sub && <div className="xs muted">{r.sub}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
export { Badge };
