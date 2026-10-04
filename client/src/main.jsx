import { StrictMode, Suspense, lazy, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import './styles/app.css';
import { Toasts, DialogProvider, ApprovalProvider, Loading } from './components/ui.jsx';
import { setSessionExpiredHandler } from './lib/api.js';
import { useApp } from './lib/store.js';

const Launcher = lazy(() => import('./pages/Launcher.jsx'));
const Setup = lazy(() => import('./pages/Setup.jsx'));
const DeviceSetup = lazy(() => import('./pages/DeviceSetup.jsx'));
const Login = lazy(() => import('./pages/Login.jsx'));
const POS = lazy(() => import('./pages/pos/POS.jsx'));
const KDS = lazy(() => import('./pages/KDS.jsx'));
const QueueDisplay = lazy(() => import('./pages/QueueDisplay.jsx'));
const CustomerDisplay = lazy(() => import('./pages/CustomerDisplay.jsx'));
const Admin = lazy(() => import('./pages/admin/Admin.jsx'));
const MemberApp = lazy(() => import('./pages/member/MemberApp.jsx'));

function SessionWatcher() {
  const nav = useNavigate();
  useEffect(() => {
    setSessionExpiredHandler((err) => {
      const s = useApp.getState();
      if (!s.staff) return;
      s.logout(false);
      s.toast(err.message || 'Session หมดอายุ', 'warning');
      nav('/login');
    });
  }, [nav]);
  return null;
}

function App() {
  return (
    <BrowserRouter>
      <DialogProvider>
        <SessionWatcher />
        <Suspense fallback={<Loading />}>
          <Routes>
            <Route path="/" element={<Launcher />} />
            <Route path="/setup" element={<Setup />} />
            <Route path="/device" element={<DeviceSetup />} />
            <Route path="/login" element={<Login />} />
            <Route path="/pos/*" element={<POS />} />
            <Route path="/kds" element={<KDS />} />
            <Route path="/queue" element={<QueueDisplay />} />
            <Route path="/display" element={<CustomerDisplay />} />
            <Route path="/admin/*" element={<Admin />} />
            <Route path="/m/*" element={<MemberApp />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
        <ApprovalProvider />
        <Toasts />
      </DialogProvider>
    </BrowserRouter>
  );
}

createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
