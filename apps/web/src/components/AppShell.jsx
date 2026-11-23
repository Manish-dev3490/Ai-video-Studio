import {useEffect, useRef, useState} from 'react';
import {FolderOpen, LayoutDashboard, LogOut, Menu, Plus, Settings2, X, ChevronRight} from 'lucide-react';
import {Link, NavLink, Outlet, useLocation, useNavigate} from 'react-router-dom';
import {useDispatch} from 'react-redux';
import {studioApi, useGetAccountProfileQuery, useGetCapabilitiesQuery, useGetMeQuery, useLogoutMutation} from '../store/api.js';
import {resetDraft} from '../store/index.js';
import {friendlyError} from '../lib/forms.js';
import {Brand} from './ui.jsx';
import {notifySessionChanged} from '../lib/session-events.js';

const links = [{to: '/app', label: 'Overview', icon: LayoutDashboard, end: true}, {to: '/app/create', label: 'Create video', icon: Plus}, {to: '/app/projects', label: 'My projects', icon: FolderOpen}, {to: '/app/settings', label: 'Account', icon: Settings2}];

export function AppShell() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [logoutError, setLogoutError] = useState('');
  const navigationRef = useRef(null);
  const menuRef = useRef(null);
  const openedBefore = useRef(false);
  const {data: user} = useGetMeQuery();
  const {data: account} = useGetAccountProfileQuery();
  const {data: capabilities} = useGetCapabilitiesQuery(undefined, {pollingInterval: 10000, skipPollingIfUnfocused: true});
  const [logout, {isLoading: signingOut}] = useLogoutMutation();
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const location = useLocation();
  const current = links.find(link => link.to === location.pathname)?.label || (location.pathname.endsWith('/assistant') ? 'AI assistant' : location.pathname.endsWith('/review') ? 'Script review' : location.pathname.endsWith('/generating') ? 'Render progress' : location.pathname.endsWith('/preview') ? 'Video preview' : 'Studio');
  const initials = (user?.displayName || 'You').split(/\s+/u).map(part => Array.from(part)[0]).slice(0, 2).join('').toUpperCase();

  useEffect(() => {
    if (!mobileOpen) { if (openedBefore.current) menuRef.current?.focus(); return; }
    openedBefore.current = true;
    const sidebar = navigationRef.current;
    const focusable = () => Array.from(sidebar.querySelectorAll('a,button:not([disabled])')).filter(element => element.getClientRects().length);
    focusable()[0]?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    function onKey(event) {
      if (event.key === 'Escape') { setMobileOpen(false); return; }
      if (event.key !== 'Tab') return;
      const controls = focusable();
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    document.addEventListener('keydown', onKey);
    return () => { document.body.style.overflow = previousOverflow; document.removeEventListener('keydown', onKey); };
  }, [mobileOpen]);

  async function signOut() {
    setLogoutError('');
    try {
      await logout().unwrap();
      navigate('/login', {replace: true, state: {signedOut: true}});
      dispatch(resetDraft());
      dispatch(studioApi.util.resetApiState());
      notifySessionChanged();
    } catch (error) { setLogoutError(friendlyError(error, 'Could not sign out. Please try again.')); }
  }

  return <div className="app-shell">
    <a className="skip-link" href="#main-content">Skip to content</a>
    {mobileOpen && <button className="sidebar-backdrop" aria-label="Close navigation" onClick={() => setMobileOpen(false)} />}
    <aside ref={navigationRef} className={`sidebar ${mobileOpen ? 'is-open' : ''}`} aria-label="Studio navigation">
      <div className="sidebar-brand"><NavLink to="/app" onClick={() => setMobileOpen(false)} aria-label="AI Video Studio overview"><Brand /></NavLink><button className="icon-button mobile-only" aria-label="Close navigation" onClick={() => setMobileOpen(false)}><X size={20} /></button></div>
      <div className="workspace-label">PERSONAL WORKSPACE</div>
      <nav>{links.map(({to, label, icon: Icon, end}) => <NavLink key={to} to={to} end={end} onClick={() => setMobileOpen(false)} className={({isActive}) => `nav-item ${isActive ? 'is-active' : ''}`}><Icon size={18} strokeWidth={1.7} /><span>{label}</span>{to === '/app/create' && <span className="nav-plus" aria-hidden="true">+</span>}</NavLink>)}</nav>
      <div className="sidebar-note"><div className="small-orbit" aria-hidden="true"><span /><span /><span /></div><strong>Small idea. Big picture.</strong><p>A focused space for your next visual story.</p><NavLink to="/app/create" onClick={() => setMobileOpen(false)}>Shape an idea <ChevronRight size={14} /></NavLink></div>
      <div className="sidebar-bottom">
        {logoutError && <p className="inline-error" role="alert">{logoutError}</p>}
        <div className="sidebar-profile"><span className="avatar">{initials}</span><div><strong>{user?.displayName}</strong><span>Personal account</span></div><button className="icon-button signout-button" title="Sign out" aria-label="Sign out" disabled={signingOut} onClick={signOut}><LogOut size={17} /></button></div>
      </div>
    </aside>
    <div className="workspace-main">
      <header className="topbar"><div className="topbar-left"><button ref={menuRef} className="icon-button mobile-only" aria-label="Open navigation" aria-expanded={mobileOpen} onClick={() => setMobileOpen(true)}><Menu size={21} /></button><span className="breadcrumb-root">Workspace</span><ChevronRight size={13} /><span>{current}</span></div><div className="topbar-right"><span className={`worker-status ${capabilities?.worker?.available ? 'is-online' : ''}`}><i />{capabilities ? capabilities.worker.available ? 'Worker online' : 'Rendering offline' : 'Checking availability'}</span><span className="avatar avatar-small" title={user?.displayName}>{initials}</span></div></header>
      <main id="main-content" className="page-content" tabIndex={-1}>{account && !account.emailVerified && location.pathname !== "/app/settings" && <div className="email-verification-banner"><div><strong>Confirm your email address</strong><p>Manage verification and your sign-in details in Account. Your workspace remains available.</p></div><Link className="text-link" to="/app/settings">Review email settings<ChevronRight size={14} /></Link></div>}<Outlet /></main>
      <footer className="app-footer"><span>AI Video Studio</span><span>Made for ideas worth explaining.</span></footer>
    </div>
  </div>;
}
