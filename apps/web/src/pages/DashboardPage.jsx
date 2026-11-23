import {useEffect} from 'react';
import {ArrowRight, ArrowUpRight, Check, Clapperboard, Layers, Sparkles} from 'lucide-react';
import {Link} from 'react-router-dom';
import {useGetCapabilitiesQuery, useGetMeQuery, useGetProjectsQuery, useGetUsageQuery} from '../store/api.js';
import {friendlyError} from '../lib/forms.js';
import {PromptComposer} from '../components/PromptComposer.jsx';
import {EmptyProjects, ErrorPanel, ProjectCard, SectionHeading} from '../components/ui.jsx';

function Allowance({usage, error, retry}) {
  if (error) return <ErrorPanel message={friendlyError(error)} title="Allowance unavailable" onRetry={retry} />;
  if (!usage) return <div className="allowance-card skeleton" aria-label="Loading generation allowance" />;
  const remaining = Math.max(0, usage.dailyLimit - usage.used - usage.reserved);
  return <div className="allowance-card"><span className="eyebrow">YOUR DAILY SPACE</span><div className="allowance-number"><strong>{remaining}</strong><span>of {usage.dailyLimit}<br />generation slots available</span></div><div className="allowance-track" role="progressbar" aria-label="Daily generation slots used or reserved" aria-valuemin={0} aria-valuemax={Math.max(1, usage.dailyLimit)} aria-valuenow={Math.min(usage.dailyLimit, usage.used + usage.reserved)}><span style={{width: `${usage.dailyLimit ? Math.min(100, (usage.used + usage.reserved) / usage.dailyLimit * 100) : 100}%`}} /></div><p>{usage.used} used · {usage.reserved} reserved<span>Resets daily at 00:00 UTC</span></p></div>;
}

export function DashboardPage() {
  const {data: user} = useGetMeQuery();
  const projects = useGetProjectsQuery();
  const capabilities = useGetCapabilitiesQuery();
  const usage = useGetUsageQuery();
  useEffect(() => { document.title = 'Overview · AI Video Studio'; }, []);
  const firstName = user?.displayName?.trim().split(/\s+/u)[0] || 'there';

  return <>
    <section className="dashboard-hero"><div><p className="eyebrow">A FRESH CANVAS, {firstName.toLocaleUpperCase()}</p><h1>Bring your ideas<br className="desktop-break" /> <span>to motion.</span></h1><p>Turn a thought into a story worth watching.<br />Start with the idea. Make it yours.</p></div><div className="hero-illustration" aria-hidden="true"><div className="hero-frame hero-frame-back" /><div className="hero-frame hero-frame-front"><span className="hero-frame-top"><i />THE NEXT BIG IDEA</span><div className="hero-shape"><span /><span /><span /></div><span className="hero-frame-bottom">EVERY STORY STARTS SOMEWHERE <ArrowUpRight size={15} /></span></div><span className="hero-illustration-caption">YOUR IMAGINATION, IN FRAME.</span></div></section>
    {capabilities.error && <ErrorPanel title="Studio availability could not be checked" message={friendlyError(capabilities.error)} onRetry={capabilities.refetch} />}
    <PromptComposer capabilities={capabilities.data} />
    <div className="dashboard-lower"><section className="recent-section"><SectionHeading title="Your recent projects" eyebrow="PICK UP THE THREAD"><Link className="text-link" to="/app/projects">View all <ArrowRight size={14} /></Link></SectionHeading>{projects.isLoading ? <div className="project-skeletons" aria-label="Loading recent projects"><div className="skeleton" /><div className="skeleton" /></div> : projects.error ? <ErrorPanel message={friendlyError(projects.error)} onRetry={projects.refetch} /> : projects.data?.projects.length ? <div className="project-grid">{projects.data.projects.slice(0, 3).map(project => <ProjectCard key={project.id} project={project} />)}</div> : <EmptyProjects compact />}</section><aside className="dashboard-aside"><Allowance usage={usage.data} error={usage.error} retry={usage.refetch} /><div className="studio-note"><span className="note-icon"><Layers size={18} strokeWidth={1.5} /></span><h3>Thoughtfully made,<br />one scene at a time.</h3><p>Write your idea. Review the story. Then bring it to life.</p><span><Check size={13} />Your approval comes first.</span></div></aside></div>
    <section className="workflow-strip" aria-label="The video creation process"><div className="workflow-intro"><Sparkles size={17} /><span>FROM A SPARK<br /><b>TO A STORY.</b></span></div><div><span>01</span><p><strong>Share an idea</strong>A topic, a question, a possibility.</p></div><i /><div><span>02</span><p><strong>Shape the script</strong>Review every scene before rendering.</p></div><i /><div><Clapperboard size={20} /><p><strong>Make it move</strong>Render, preview and export.</p></div></section>
  </>;
}
