import { lazy, Suspense, useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useNavigate, useLocation } from 'react-router-dom';
import { auth } from '../../lib/api.js';
import { connectSocket } from '../../lib/socket.js';
import { startSync } from '../../lib/sync.js';
import { useApp } from '../../lib/store.js';
import { Icon, Loading, Button, Select } from '../../components/ui.jsx';
import { ConnectivityBadge, NotificationBell } from '../../components/StatusBar.jsx';
import { cls } from '../../lib/util.js';

const Dashboard = lazy(() => import('./Dashboard.jsx'));
const Reports = lazy(() => import('./Reports.jsx'));
const Catalog = lazy(() => import('./Catalog.jsx'));
const Tables = lazy(() => import('./Tables.jsx'));
const Staff = lazy(() => import('./Staff.jsx'));
const Members = lazy(() => import('./Members.jsx'));
const Loyalty = lazy(() => import('./Loyalty.jsx'));
const Promotions = lazy(() => import('./Promotions.jsx'));
const Inventory = lazy(() => import('./Inventory.jsx'));
const Printers = lazy(() => import('./Printers.jsx'));
const Settings = lazy(() => import('./Settings.jsx'));
const Logs = lazy(() => import('./Logs.jsx'));

export const NAV = [
  { group: 'ภาพรวม' },
  { to: 'dashboard', label: 'Dashboard', icon: 'chart', perm: ['report.dashboard'] },
  { to: 'reports', label: 'รายงาน (Report Center)', icon: 'list', perm: ['report.sales', 'report.other_staff', 'stock.view', 'member.history'] },
  { to: 'shifts', label: 'กะการขาย (Shift)', icon: 'clock', perm: ['shift.open_close', 'shift.view_all'] },
  { group: 'สินค้า & ร้าน' },
  { to: 'products', label: 'สินค้า / หมวด / ตัวเลือก', icon: 'box', perm: ['product.create', 'product.edit', 'product.category', 'product.modifier', 'product.sold_out'] },
  { to: 'tables', label: 'โต๊ะ / Floor Plan', icon: 'table', perm: ['table.manage'] },
  { to: 'promotions', label: 'โปรโมชั่น / คูปอง', icon: 'tag', perm: ['settings.promotion'] },
  { to: 'inventory', label: 'สต็อก / วัตถุดิบ / PO', icon: 'layers', perm: ['stock.view', 'stock.in', 'stock.po', 'stock.waste'] },
  { group: 'สมาชิก & Loyalty' },
  { to: 'members', label: 'สมาชิก', icon: 'users', perm: ['member.search'] },
  { to: 'loyalty', label: 'Loyalty Program', icon: 'crown', perm: ['member.rewards', 'member.history'] },
  { group: 'พนักงาน' },
  { to: 'staff', label: 'พนักงาน & สิทธิ์', icon: 'user', perm: ['staff.create', 'staff.edit', 'staff.permission', 'staff.role'] },
  { to: 'logs', label: 'Activity Log / อนุมัติ', icon: 'shield', perm: ['audit.view'] },
  { group: 'ระบบ' },
  { to: 'printers', label: 'เครื่องพิมพ์ / Hardware', icon: 'print', perm: ['settings.printer', 'pos.access'] },
  { to: 'settings', label: 'ตั้งค่า', icon: 'settings', perm: ['settings.shop', 'settings.vat', 'settings.receipt', 'settings.point', 'settings.branch', 'settings.device', 'settings.backup', 'settings.payment'] },
];

export default function Admin() {
  const nav = useNavigate();
  const loc = useLocation();
  const { staff, settings, branches, can, device } = useApp();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    (async () => {
      if (!auth.session) return nav('/login', { replace: true });
      if (auth.deviceToken && !useApp.getState().device) await useApp.getState().loadDevice();
      if (!(await useApp.getState().loadMe())) return nav('/login', { replace: true });
      if (auth.deviceToken) { connectSocket(); startSync(); }
    })();
  }, [nav]);
  useEffect(() => setOpen(false), [loc.pathname]);
  if (!staff) return <Loading />;
  const items = NAV.filter((n) => n.group || n.perm.some((p) => can(p)));
  const first = items.find((n) => n.to)?.to || 'printers';
  const shop = settings?.shop;
  return (
    <div className="shell">
      <aside className={cls('side', open && 'open')}>
        <div className="brand">{shop?.logoUrl ? <img src={shop.logoUrl} alt="" /> : <Icon name="store" />}<span className="ellipsis">{shop?.name}</span></div>
        {staff.allBranches && branches.length > 1 && (
          <div style={{ padding: '8px 12px' }}>
            <Select value={String(staff.branchId)} onValue={(v) => { auth.branchId = v; window.location.reload(); }} options={branches.map((b) => ({ value: String(b.id), label: b.name }))} />
          </div>
        )}
        <nav>
          {items.map((n, i) => (n.group ? <div key={i} className="group">{n.group}</div> : <NavLink key={n.to} to={`/admin/${n.to}`} className={({ isActive }) => (isActive ? 'active' : '')}><Icon name={n.icon} />{n.label}</NavLink>))}
        </nav>
        <div className="grow" />
        <div className="col" style={{ padding: 12, borderTop: '1px solid var(--border)' }}>
          <div className="small"><b>{staff.displayName}</b> · {staff.role?.name}</div>
          {device?.type === 'pos' && can('pos.access') && <Button icon="cash" variant="soft" onClick={() => nav('/pos')}>ไปหน้าขาย (POS)</Button>}
          {device?.type === 'kds' && <Button icon="chef" variant="soft" onClick={() => nav('/kds')}>ไปหน้า KDS</Button>}
          <Button icon="logout" variant="ghost" onClick={async () => { await useApp.getState().logout(); nav('/login'); }}>ออกจากระบบ</Button>
        </div>
      </aside>
      <main className="main">
        <div className="topbar"><Button variant="ghost" icon="menu" onClick={() => setOpen(true)} /><b className="grow">{shop?.name}</b><NotificationBell /></div>
        <div className="row hide-mobile" style={{ justifyContent: 'flex-end', padding: '10px 20px 0' }}>{device && <ConnectivityBadge />}<NotificationBell /></div>
        <Suspense fallback={<Loading />}>
          <Routes>
            <Route index element={<Navigate to={first} replace />} />
            <Route path="dashboard" element={<Dashboard />} />
            <Route path="reports" element={<Reports />} />
            <Route path="shifts" element={<Logs tab="shifts" />} />
            <Route path="products/*" element={<Catalog />} />
            <Route path="tables" element={<Tables />} />
            <Route path="promotions" element={<Promotions />} />
            <Route path="inventory/*" element={<Inventory />} />
            <Route path="members/*" element={<Members />} />
            <Route path="loyalty/*" element={<Loyalty />} />
            <Route path="staff/*" element={<Staff />} />
            <Route path="logs" element={<Logs />} />
            <Route path="printers/*" element={<Printers />} />
            <Route path="settings/*" element={<Settings />} />
            <Route path="*" element={<Navigate to={first} replace />} />
          </Routes>
        </Suspense>
      </main>
      {open && <div className="modal-bg" style={{ zIndex: 80 }} onClick={() => setOpen(false)} />}
    </div>
  );
}

/** Page header + optional tabs */
export function Page({ title, actions, children, tabs, tab, onTab }) {
  return (
    <div className="page">
      <div className="page-h"><h1>{title}</h1><div className="row wrap">{actions}</div></div>
      {tabs && <div className="row wrap mb" style={{ gap: 6 }}>{tabs.map((t) => <button key={t.value} type="button" className={cls('chip', tab === t.value && 'on')} onClick={() => onTab(t.value)}>{t.label}</button>)}</div>}
      {children}
    </div>
  );
}
