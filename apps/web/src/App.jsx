import {useEffect} from 'react';
import {Navigate, Outlet, Route, Routes, useLocation, useParams} from 'react-router-dom';
import {useGetMeQuery} from './store/api.js';
import {AppShell} from './components/AppShell.jsx';
import {ErrorPanel, LoadingScreen} from './components/ui.jsx';
import {friendlyError} from './lib/forms.js';
import {AuthPage} from './pages/AuthPage.jsx';
import {DashboardPage} from './pages/DashboardPage.jsx';
import {ProjectsPage} from './pages/ProjectsPage.jsx';
import {AccountPage} from './pages/AccountPage.jsx';
import {CreatePage} from './pages/CreatePage.jsx';
import {ReviewPage} from './pages/ReviewPage.jsx';
import {GenerationPage} from './pages/GenerationPage.jsx';
import {PreviewPage} from './pages/PreviewPage.jsx';
import {RecoveryPage} from './pages/RecoveryPage.jsx';
import {AssistantPage} from './pages/AssistantPage.jsx';

function ProtectedRoute() {
  const {data: user, isLoading, error, refetch} = useGetMeQuery(undefined, {refetchOnMountOrArgChange: true});
  const location = useLocation();
  if (isLoading) return <LoadingScreen message="Opening your private workspace…" />;
  if (error?.status === 401) return <Navigate to="/login" replace state={{from: location.pathname + location.search}} />;
  if (error) return <div className="state-screen"><ErrorPanel title="Your workspace is temporarily unavailable" message={friendlyError(error)} onRetry={refetch} /></div>;
  return user ? <Outlet /> : <Navigate to="/login" replace />;
}

function ScrollToTop() {
  const {pathname} = useLocation();
  useEffect(() => { window.scrollTo(0, 0); }, [pathname]);
  return null;
}

function ProjectScreen({component: Screen}) {
  const {projectId} = useParams();
  const {search} = useLocation();
  return <Screen key={`${projectId}:${search}`} />;
}

function RecoveryScreen({mode}) {
  return <RecoveryPage key={mode} mode={mode} />;
}

export function App() {
  return <><ScrollToTop /><Routes><Route path="/" element={<Navigate to="/app" replace />} /><Route path="/login" element={<AuthPage key="login" mode="login" />} /><Route path="/signup" element={<AuthPage key="signup" mode="signup" />} /><Route path="/forgot-password" element={<RecoveryScreen mode="forgot" />} /><Route path="/reset-password" element={<RecoveryScreen mode="reset" />} /><Route path="/verify-email" element={<RecoveryScreen mode="verify" />} /><Route path="/confirm-email-change" element={<RecoveryScreen mode="email" />} /><Route element={<ProtectedRoute />}><Route path="/app" element={<AppShell />}><Route index element={<DashboardPage />} /><Route path="create" element={<CreatePage />} /><Route path="projects" element={<ProjectsPage />} /><Route path="projects/:projectId/assistant" element={<ProjectScreen component={AssistantPage} />} /><Route path="projects/:projectId/review" element={<ProjectScreen component={ReviewPage} />} /><Route path="projects/:projectId/generating" element={<ProjectScreen component={GenerationPage} />} /><Route path="projects/:projectId/preview" element={<ProjectScreen component={PreviewPage} />} /><Route path="settings" element={<AccountPage />} /><Route path="*" element={<div className="not-found"><p className="eyebrow">A LITTLE OFF THE STORYBOARD</p><h1>This page is not here.</h1><p>Choose Overview or My projects from the studio navigation.</p></div>} /></Route></Route><Route path="*" element={<Navigate to="/app" replace />} /></Routes></>;
}
