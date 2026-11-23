import {useEffect, useId, useRef, useState} from 'react';
import {Flag, Send, ShieldCheck} from 'lucide-react';
import {useGetMeQuery, useGetProjectsQuery} from '../store/api.js';
import {codePoints} from '../lib/forms.js';
import {reportError, reportFormErrors, reportOutcomeUncertain, reportPrivacyVersion, reportReasons, requestReport, subscribeReportPrivacy} from '../lib/reports.js';

export function ReportMisuse({projectId, assetId, selectProject = false}) {
  const identity = useGetMeQuery();
  const projects = useGetProjectsQuery({limit: 20}, {skip: !selectProject});
  const fixedTarget = assetId || projectId || '';
  const fixedKind = assetId ? 'assetId' : 'projectId';
  const [targetKind, setTargetKind] = useState(fixedKind);
  const [targetId, setTargetId] = useState(fixedTarget);
  const [reasonCode, setReasonCode] = useState('SAFETY');
  const [description, setDescription] = useState('');
  const [errors, setErrors] = useState({});
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState(null);
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const operation = useRef(null);
  const detail = useRef(null);
  const message = useRef(null);
  const id = useId();
  const latestOwner = useRef(identity.data?.id); latestOwner.current = identity.data?.id;
  const ownerId = identity.data?.id;
  function clear() {
    operation.current?.controller.abort(); operation.current = null;
    setDescription(''); setErrors({}); setError(''); setReceipt(null); setPending(false); setUncertain(false);
    setReasonCode('SAFETY'); setTargetKind(fixedKind); setTargetId(fixedTarget);
    if (detail.current) detail.current.open = false;
  }
  useEffect(() => {
    clear();
    const unsubscribe = subscribeReportPrivacy(clear);
    return () => {unsubscribe(); operation.current?.controller.abort(); operation.current = null;};
  }, [ownerId, fixedTarget, fixedKind]);
  useEffect(() => {if (receipt) message.current?.focus();}, [receipt]);
  async function submit(event) {
    event.preventDefault();
    if (operation.current || uncertain || !ownerId) return;
    const fields = {targetKind, targetId, reasonCode, description};
    const invalid = reportFormErrors(fields); setErrors(invalid); setError(''); setReceipt(null);
    if (Object.keys(invalid).length) {
      const key = Object.keys(invalid)[0]; document.getElementById(`${id}-${key}`)?.focus();
      return;
    }
    const task = {controller: new AbortController(), ownerId, version: reportPrivacyVersion()};
    operation.current = task; setPending(true);
    const current = () => operation.current === task && !task.controller.signal.aborted && latestOwner.current === task.ownerId && task.version === reportPrivacyVersion();
    try {
      const saved = await requestReport(fields, {signal: task.controller.signal});
      if (!current()) return;
      setReceipt(saved); setDescription(''); setReasonCode('SAFETY'); setErrors({});
    } catch (failure) {
      if (!current()) return;
      if (reportOutcomeUncertain(failure)) {
        setUncertain(true); setDescription('');
        setError('The connection ended before confirmation. Your report may already be saved. Avoid submitting the same concern again.');
      } else setError(reportError(failure));
    } finally {
      if (current()) {operation.current = null; setPending(false);}
    }
  }
  const controlsDisabled = pending || uncertain || Boolean(receipt);
  const savedProjects = projects.data?.items || projects.data?.projects || [];
  return <details className="report-misuse" ref={detail}>
    <summary><Flag size={16} />Report misuse<span>Private review</span></summary>
    <div className="report-misuse-content"><div className="report-intro"><ShieldCheck size={19} /><div><h2>Tell us about a concern</h2><p>Reports are reviewed privately. Submitting a report does not automatically remove content, and a receipt does not confirm the target exists.</p></div></div>
      <p className="report-privacy-note" id={`${id}-privacy`}>Do not include passwords, API keys or unnecessary personal information. Use a brief description of the concern. Reports are stored for operator review; a final retention policy is pending.</p>
      {receipt ? <div className="success-message report-receipt" role="status" tabIndex={-1} ref={message}><strong>Report received for private review.</strong><p>Reference: <code>{receipt.id}</code></p><p>Keep this reference for your records.</p></div> : <form onSubmit={submit} noValidate aria-label="Report misuse" aria-describedby={`${id}-privacy`}>
        {!fixedTarget ? <>
          {selectProject && savedProjects.length > 0 && <div className="field"><label htmlFor={`${id}-saved-project`}>Choose one of your projects (optional)</label><select id={`${id}-saved-project`} disabled={controlsDisabled} value={targetKind === 'projectId' && savedProjects.some(project => project.id === targetId) ? targetId : ''} onChange={event => {setTargetKind('projectId'); setTargetId(event.target.value);}}><option value="">Enter an ID below</option>{savedProjects.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}</select></div>}
          <div className="report-target-fields"><div className="field"><label htmlFor={`${id}-targetKind`}>Report target</label><select id={`${id}-targetKind`} value={targetKind} disabled={controlsDisabled} onChange={event => {setTargetKind(event.target.value); setTargetId('');}}><option value="projectId">Project</option><option value="assetId">Video or caption asset</option></select></div><div className="field"><label htmlFor={`${id}-targetId`}>{targetKind === 'assetId' ? 'Asset ID' : 'Project ID'}</label><input id={`${id}-targetId`} value={targetId} onChange={event => setTargetId(event.target.value)} disabled={controlsDisabled} spellCheck={false} autoComplete="off" autoCapitalize="none" aria-invalid={Boolean(errors.targetId)} aria-describedby={`${id}-target-hint${errors.targetId ? ` ${id}-target-error` : ''}`} /></div></div><p className="field-hint" id={`${id}-target-hint`}>Use a project ID from its dashboard URL, or an asset ID you already have. This form does not look up other users’ content.</p>
        </> : <p className="report-target-context">Reporting this {fixedKind === 'assetId' ? 'output asset' : 'project'}: <code>{fixedTarget}</code></p>}
        {errors.targetId && <p className="field-error" id={`${id}-target-error`}>{errors.targetId}</p>}
        <div className="field"><label htmlFor={`${id}-reasonCode`}>Concern</label><select id={`${id}-reasonCode`} value={reasonCode} onChange={event => setReasonCode(event.target.value)} disabled={controlsDisabled} aria-invalid={Boolean(errors.reasonCode)}>{reportReasons.map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select></div>
        <div className="field"><label htmlFor={`${id}-description`}>Describe the concern</label><textarea id={`${id}-description`} value={description} onChange={event => setDescription(event.target.value)} rows={4} disabled={controlsDisabled} autoComplete="off" spellCheck={false} aria-invalid={Boolean(errors.description)} aria-describedby={`${id}-length${errors.description ? ` ${id}-description-error` : ''}`} placeholder="Explain what should be reviewed, without sharing private credentials." /><p className="field-hint" id={`${id}-length`}>{codePoints(description).toLocaleString('en-US')} / 2,000 characters</p>{errors.description && <p className="field-error" id={`${id}-description-error`}>{errors.description}</p>}</div>
        {error && <p className="form-alert" role="alert">{error}</p>}
        <div className="report-submit-row"><button className="button button-secondary" type="submit" disabled={controlsDisabled || !ownerId}><Send size={15} />{pending ? 'Submitting report…' : 'Submit private report'}</button><p>No automatic takedown or account action.</p></div>
      </form>}
      {(receipt || uncertain) && <button className="text-link report-another" onClick={() => {clear(); if (detail.current) detail.current.open = true;}}>Start a different report</button>}
    </div>
  </details>;
}
