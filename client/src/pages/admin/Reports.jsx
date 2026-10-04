import { useEffect, useState } from 'react';
import { api, download } from '../../lib/api.js';
import { useApp, toast } from '../../lib/store.js';
import { Page } from './Admin.jsx';
import { RangePicker } from './Dashboard.jsx';
import { Button, Input, Select, DataTable, Spinner, ErrorBox } from '../../components/ui.jsx';
import { money, today, PAYMENT_METHOD_LABEL } from '../../lib/util.js';

export default function Reports() {
  const can = useApp((s) => s.can);
  const [list, setList] = useState([]);
  const [key, setKey] = useState('sales');
  const [range, setRange] = useState({ from: today(), to: today(), preset: 'today', branch: 'current' });
  const [f, setF] = useState({ timeFrom: '', timeTo: '', staffId: '', productId: '', categoryId: '', method: '', deviceId: '' });
  const [opts, setOpts] = useState({ staff: [], products: [], categories: [], devices: [] });
  const [rep, setRep] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api('/reports').then((l) => { setList(l); if (l.length && !l.some((x) => x.key === key)) setKey(l[0].key); }).catch(setErr);
    Promise.all([can('report.other_staff') ? api('/staff').catch(() => []) : [], api('/products').catch(() => []), api('/categories').catch(() => []), api('/devices').catch(() => [])])
      .then(([staff, products, categories, devices]) => setOpts({ staff, products, categories, devices }));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const qs = () => new URLSearchParams(Object.entries({ from: range.from, to: range.to, branchId: range.branch === 'all' ? 'all' : '', ...f }).filter(([, v]) => v)).toString();
  const run = async () => { setBusy(true); try { setRep(await api(`/reports/${key}?${qs()}`)); setErr(null); } catch (e) { setErr(e); } finally { setBusy(false); } };
  useEffect(() => { if (key) run(); }, [key, range]); // eslint-disable-line react-hooks/exhaustive-deps
  const exp = (fmt) => download(`/reports/${key}?${qs()}&format=${fmt}`).catch((e) => toast(e.message, 'error'));
  const fmt = (c, v) => (v == null ? '' : c.type === 'money' ? money(v) : c.type === 'pct' ? `${Number(v).toFixed(1)}%` : c.type === 'num' ? Math.round(v * 1000) / 1000 : String(v));
  return (
    <Page title="Report Center" actions={can('report.export') && rep && <><Button icon="download" onClick={() => exp('pdf')}>PDF</Button><Button icon="download" onClick={() => exp('xlsx')}>XLSX</Button><Button icon="download" onClick={() => exp('csv')}>CSV</Button></>}>
      <div className="col gap-l">
        <div className="row wrap" style={{ gap: 6 }}>{list.map((r) => <button key={r.key} type="button" className={`chip ${key === r.key ? 'on' : ''}`} onClick={() => setKey(r.key)}>{r.title.replace(/\s*\(.+\)/, '')}</button>)}</div>
        <div className="card pad col">
          <RangePicker value={range} onChange={setRange} allowAll />
          <div className="grid-4">
            <Input type="time" label="ตั้งแต่เวลา" value={f.timeFrom} onValue={(v) => setF({ ...f, timeFrom: v })} />
            <Input type="time" label="ถึงเวลา" value={f.timeTo} onValue={(v) => setF({ ...f, timeTo: v })} />
            {can('report.other_staff') && <Select label="พนักงาน" value={f.staffId} onValue={(v) => setF({ ...f, staffId: v })} placeholder="ทั้งหมด" options={opts.staff.map((s) => ({ value: String(s.id), label: `${s.employee_code} ${s.nickname || s.first_name}` }))} />}
            <Select label="POS" value={f.deviceId} onValue={(v) => setF({ ...f, deviceId: v })} placeholder="ทั้งหมด" options={opts.devices.filter((d) => d.type === 'pos').map((d) => ({ value: String(d.id), label: d.name }))} />
            <Select label="สินค้า" value={f.productId} onValue={(v) => setF({ ...f, productId: v })} placeholder="ทั้งหมด" options={opts.products.map((p) => ({ value: String(p.id), label: p.name }))} />
            <Select label="หมวด" value={f.categoryId} onValue={(v) => setF({ ...f, categoryId: v })} placeholder="ทั้งหมด" options={opts.categories.map((c) => ({ value: String(c.id), label: c.name }))} />
            <Select label="ช่องทางชำระ" value={f.method} onValue={(v) => setF({ ...f, method: v })} placeholder="ทั้งหมด" options={Object.entries(PAYMENT_METHOD_LABEL).map(([value, label]) => ({ value, label }))} />
            <div className="field"><label>&nbsp;</label><Button variant="primary" loading={busy} onClick={run}>แสดงรายงาน</Button></div>
          </div>
        </div>
        <ErrorBox error={err} />
        {!rep ? busy && <div className="center"><Spinner /></div> : (
          <div className="col">
            <h3>{rep.title} <span className="small muted">{rep.range.from} – {rep.range.to}</span></h3>
            <DataTable columns={rep.columns.map((c) => ({ key: c.key, label: c.label, num: ['money', 'int', 'num', 'pct'].includes(c.type), render: (r) => fmt(c, r[c.key]) }))} rows={rep.rows}
              footer={Object.keys(rep.totals).length ? Object.fromEntries(rep.columns.map((c, i) => [c.key, i === 0 ? 'รวม' : rep.totals[c.key] != null ? fmt(c, rep.totals[c.key]) : ''])) : null} />
          </div>
        )}
      </div>
    </Page>
  );
}
