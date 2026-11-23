import {useEffect, useRef, useState} from 'react';
import {ArrowLeft, ArrowRight, Captions, Download, Film, RefreshCw} from 'lucide-react';
import {Link, useParams, useSearchParams} from 'react-router-dom';
import {useGetAssetQuery, useGetGenerationQuery, useGetProjectQuery, useGetStoryboardQuery} from '../store/api.js';
import {ErrorPanel, LoadingScreen} from '../components/ui.jsx';
import {friendlyError} from '../lib/forms.js';
import {assetAvailable, assetUrl} from '../lib/storyboard.js';
import {ReportMisuse} from '../components/ReportMisuse.jsx';

export function PreviewPage() {
  const {projectId} = useParams();
  const [search] = useSearchParams();
  const explicitGeneration = search.get('generation');
  const project = useGetProjectQuery(projectId);
  const latest = useGetAssetQuery(project.data?.latestOutputAssetId, {skip: Boolean(explicitGeneration) || !project.data?.latestOutputAssetId});
  const generationId = explicitGeneration || latest.data?.generationId;
  const generation = useGetGenerationQuery(generationId, {skip: !generationId});
  const video = useGetAssetQuery(generation.data?.outputAssetId, {skip: !generation.data?.outputAssetId});
  const captions = useGetAssetQuery(generation.data?.captionAssetId, {skip: !generation.data?.captionAssetId});
  const storyboard = useGetStoryboardQuery({projectId, storyboardId: generation.data?.storyboardId}, {skip: !generation.data?.storyboardId});
  const [captionsEnabled, setCaptionsEnabled] = useState(false);
  const [playbackError, setPlaybackError] = useState('');
  const [downloadError, setDownloadError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [playerRevision, setPlayerRevision] = useState(0);
  const player = useRef(null);
  const [now, setNow] = useState(Date.now());
  const pairReady = assetAvailable(video.data, now) && assetAvailable(captions.data, now) && video.data.expiresAt === captions.data.expiresAt && video.data.generationId === captions.data.generationId;
  useEffect(() => {document.title = `${project.data?.title || 'Video preview'} · AI Video Studio`;}, [project.data?.title]);
  useEffect(() => {const interval = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(interval);}, []);
  const syncCaptions = () => {if (player.current) for (const track of player.current.textTracks) track.mode = captionsEnabled ? 'showing' : 'hidden';};
  useEffect(syncCaptions, [captionsEnabled, playerRevision]);
  async function reloadPlayback() {
    setRefreshing(true); setPlaybackError('');
    try {await Promise.all([video.refetch().unwrap(), captions.refetch().unwrap()]); setPlayerRevision(value => value + 1);}
    catch (error) {setPlaybackError(friendlyError(error, 'Playback is unavailable. Check this output’s availability and try again.'));}
    finally {setRefreshing(false);}
  }
  async function download(kind) {
    setDownloadError('');
    try {
      const query = kind === 'video' ? video : captions;
      const asset = await query.refetch().unwrap();
      if (!assetAvailable(asset)) {setDownloadError('This output has expired or is no longer available.'); return;}
      const link = document.createElement('a'); link.href = assetUrl(asset.id); link.download = kind === 'video' ? 'video.mp4' : 'captions.vtt'; document.body.appendChild(link); link.click(); link.remove();
    } catch (error) {setDownloadError(friendlyError(error, 'The download could not be authorized. Please try again.'));}
  }
  if (project.isLoading) return <LoadingScreen message="Opening your video…" />;
  if (project.error) return <><ErrorPanel title="Project unavailable" message={friendlyError(project.error, 'This project is no longer available.')} onRetry={project.refetch} /><ReportMisuse projectId={projectId} /></>;
  const outputError = latest.error || generation.error || video.error || captions.error;
  const loading = latest.isLoading || generation.isLoading || video.isLoading || captions.isLoading;
  const savedOutput = project.data.latestOutputAssetId || generation.data?.outputAssetId;
  const wrongProject = generation.data && generation.data.projectId !== projectId;
  return <><Link className="text-link back-link" to="/app/projects"><ArrowLeft size={14} />My projects</Link><div className="project-page-heading"><div><p className="eyebrow">YOUR STORY, IN MOTION</p><h1>{project.data.title}</h1><p>AI-generated visuals and narration. Review the content before sharing.</p></div><Link className="button button-secondary" to={`/app/projects/${encodeURIComponent(projectId)}/review${generation.data?.storyboardId ? '?storyboard=' + encodeURIComponent(generation.data.storyboardId) : ''}`}>View approved script<ArrowRight size={15} /></Link></div>
    {loading ? <LoadingScreen message="Checking the video and caption track…" /> : wrongProject ? <ErrorPanel title="Output unavailable" message="This generation does not belong to the selected project." /> : outputError ? <ErrorPanel title="Output unavailable" message={friendlyError(outputError, 'This output is private, deleted or no longer available.')} onRetry={() => {project.refetch(); if (generationId) generation.refetch(); if (generation.data?.outputAssetId) video.refetch(); if (generation.data?.captionAssetId) captions.refetch();}} /> : !savedOutput ? <section className="storyboard-empty"><Film size={30} /><h2>No saved video yet.</h2><p>Approve a script and complete a generation first.</p><Link className="button button-primary" to={`/app/projects/${encodeURIComponent(projectId)}/review`}>Open script<ArrowRight size={16} /></Link></section> : <div className="preview-grid"><section className="preview-main">{pairReady ? <div className="video-player-frame"><video key={playerRevision} ref={player} controls playsInline preload="metadata" src={assetUrl(video.data.id)} onLoadedMetadata={syncCaptions} onError={() => setPlaybackError('The video could not be loaded. Refresh playback to check your session and output availability.')}><track kind="captions" src={assetUrl(captions.data.id)} srcLang="en" label="English captions" default={captionsEnabled} />Your browser does not support this video player.</video></div> : <div className="video-unavailable"><Film size={35} /><h2>{video.data?.availability === 'EXPIRED' || captions.data?.availability === 'EXPIRED' ? 'This output has expired.' : 'This output is unavailable.'}</h2><p>Video and captions are retained for seven days after publication. Your saved project and approved script are preserved.</p><Link className="button button-secondary" to={`/app/projects/${encodeURIComponent(projectId)}/review`}>Open saved script</Link></div>}
      {playbackError && <ErrorPanel title="Playback could not continue" message={playbackError} onRetry={reloadPlayback} />}
      {pairReady && <div className="video-player-tools"><label className="caption-toggle"><Captions size={18} /><input type="checkbox" checked={captionsEnabled} onChange={event => setCaptionsEnabled(event.target.checked)} />English captions</label><button className="text-link" disabled={refreshing} onClick={reloadPlayback}><RefreshCw size={14} />{refreshing ? 'Refreshing…' : 'Refresh playback'}</button></div>}
      <p className="preview-disclosure">The MP4 contains clean video and narration. Captions are a separate synchronized track and can be downloaded independently.</p></section><aside className="export-panel"><p className="eyebrow">READY TO TAKE IT WITH YOU</p><h2>Your export</h2><dl className="export-details"><div><dt>Requested length</dt><dd>{storyboard.data ? `${storyboard.data.targetDurationSec} seconds` : 'From approved script'}</dd></div><div><dt>Actual length</dt><dd>{video.data?.durationSec ? `${video.data.durationSec.toFixed(2)} seconds` : 'Unavailable'}</dd></div><div><dt>Format</dt><dd>MP4 · 720p · 30 FPS</dd></div><div><dt>Captions</dt><dd>English WebVTT</dd></div>{video.data?.expiresAt && <div><dt>Available until</dt><dd><time dateTime={video.data.expiresAt}>{new Date(video.data.expiresAt).toLocaleString()}</time></dd></div>}</dl>{downloadError && <p className="inline-error" role="alert">{downloadError}</p>}<button className="button button-primary" disabled={!pairReady} onClick={() => download('video')}><Download size={16} />Download MP4</button><button className="button button-secondary" disabled={!pairReady} onClick={() => download('captions')}><Download size={16} />Download captions</button><p className="field-hint">Both downloads are private to your signed-in account.</p></aside></div>}
    <ReportMisuse projectId={projectId} assetId={!wrongProject && video.data?.id ? video.data.id : undefined} />
  </>;
}
