'use client';

import {useId, useRef, useState} from 'react';
import {CONTRIBUTION_MAX_BYTES, parseContributionManifest} from '@/scripts/charmville/contribution-schema.mjs';
import styles from './contribution-panel.module.css';

type Pack = {id: string; version: string; manifestSha256: string};
type Evidence = {kind: 'visual' | 'rights' | 'compatibility'; path: string; sha256: string};
type Proposal = {schemaVersion: 1; id: string; baseCommit: string; summary: string; packs: Pack[]; evidence: Evidence[]};
const digest = async (bytes: ArrayBuffer) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');

/** Produces a review envelope only. Files remain on this device. */
export default function ContributionPanel() {
  const prefix = useId();
  const [id, setId] = useState('');
  const [baseCommit, setBaseCommit] = useState('');
  const [summary, setSummary] = useState('');
  const [packs, setPacks] = useState<Pack[]>([]);
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [kind, setKind] = useState<Evidence['kind']>('visual');
  const [notice, setNotice] = useState('Add a pack manifest to begin your proposal.');
  const [busy, setBusy] = useState(false);
  const [reviewed, setReviewed] = useState<string | null>(null);
  const uploadLock = useRef(false);
  const revision = useRef(0);
  const change = () => { revision.current++; setReviewed(null); };
  const proposal = (): Proposal => ({schemaVersion: 1, id, baseCommit, summary, packs, evidence});

  async function addFile(file: File | undefined, purpose: 'pack' | 'evidence' | 'proposal') {
    if (!file || uploadLock.current) return;
    uploadLock.current = true; setBusy(true); change();
    const startedAt = revision.current;
    try {
      const limit = purpose === 'proposal' ? CONTRIBUTION_MAX_BYTES : purpose === 'pack' ? 262144 : 8 * 1024 * 1024;
      if (file.size > limit) throw Error(`File is too large. Limit: ${Math.ceil(limit / 1024)} KB.`);
      const bytes = await file.arrayBuffer();
      if (purpose === 'proposal') {
        const value = parseContributionManifest(new Uint8Array(bytes)) as Proposal;
        if (revision.current !== startedAt) throw Error('The draft changed while reading. Import again when ready.');
        setId(value.id); setBaseCommit(value.baseCommit); setSummary(value.summary); setPacks([...value.packs]); setEvidence([...value.evidence]);
        setNotice('Proposal imported. Its references still require the original files and reviewer verification.');
      } else if (purpose === 'pack') {
        if (packs.length >= 16) throw Error('A proposal can contain up to 16 packs.');
        const value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
        if (!value || typeof value.id !== 'string' || typeof value.version !== 'string') throw Error('Choose a pack manifest with an id and version.');
        const pin = {id: value.id, version: value.version, manifestSha256: await digest(bytes)};
        // Apply the same envelope checks used by the command-line reviewer.
        parseContributionManifest(new TextEncoder().encode(JSON.stringify({schemaVersion: 1, id: 'review.draft', baseCommit: '0'.repeat(40), summary: 'Draft', packs: [...packs, pin], evidence: []})));
        if (revision.current !== startedAt) throw Error('The draft changed while reading. Add the file again.');
        setPacks(current => [...current, pin]); setNotice('Pack fingerprint added. Pack contents and assets need separate review.');
      } else {
        if (evidence.length >= 32) throw Error('A proposal can contain up to 32 evidence files.');
        if (!/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.(png|json|md)$/.test(file.name)) throw Error('Use a PNG, JSON or Markdown filename containing only letters, numbers, dots, dashes or underscores.');
        const entry = {kind, path: `evidence/${file.name}`, sha256: await digest(bytes)};
        if (evidence.some(item => item.path === entry.path)) throw Error('That evidence filename is already included.');
        if (revision.current !== startedAt) throw Error('The draft changed while reading. Add the file again.');
        setEvidence(current => [...current, entry]); setNotice('Evidence fingerprint added. Keep the original file beside your exported proposal.');
      }
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Could not read this file.'); }
    finally { uploadLock.current = false; setBusy(false); }
  }

  function validate() {
    try {
      const encoded = JSON.stringify(proposal(), null, 2);
      parseContributionManifest(new TextEncoder().encode(encoded));
      setReviewed(encoded); setNotice('Envelope checks passed. Ready to export for review; no game changes have been applied.');
    } catch (error) { setReviewed(null); setNotice(error instanceof Error ? error.message : 'Check the proposal fields.'); }
  }
  function download() {
    if (!reviewed) return;
    const url = URL.createObjectURL(new Blob([reviewed + '\n'], {type: 'application/json'}));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${id}.proposal.json`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice('Proposal exported. Send it with the original pack manifests and evidence to your repository reviewer.');
  }

  return <section className={styles.shell} aria-label="Creator workshop">
    <header className={styles.header}><div><small>CHARMDEX / CREATE</small><h2>Creator workshop</h2></div><span>Draft → Check → Review</span></header>
    <p className={styles.intro}>Make something worth sharing. Prepare a change for your team to review while the world keeps playing.</p>
    <div className={styles.form}>
      <label htmlFor={`${prefix}-id`}>Proposal name <small>creator.change-name</small><input id={`${prefix}-id`} value={id} maxLength={121} placeholder="yourname.village-signs" onChange={event => {change(); setId(event.target.value);}} /></label>
      <label htmlFor={`${prefix}-base`}>Starting revision <small>40-character Git commit</small><input id={`${prefix}-base`} value={baseCommit} maxLength={40} autoCapitalize="none" spellCheck={false} onChange={event => {change(); setBaseCommit(event.target.value.trim());}} /></label>
      <label className={styles.wide} htmlFor={`${prefix}-summary`}>What will players experience?<textarea id={`${prefix}-summary`} rows={3} maxLength={500} value={summary} placeholder="Describe the change and how it helps players." onChange={event => {change(); setSummary(event.target.value.replace(/[\r\n]/g, ' '));}} /></label>
      <fieldset className={styles.wide} disabled={busy}><legend>Pack manifests · {packs.length}/16</legend><p>A pack is a versioned collection of proposed content. Its fingerprint locks the exact file for review.</p><input aria-label="Add pack manifest" type="file" accept=".json,application/json" onChange={event => {void addFile(event.target.files?.[0], 'pack'); event.target.value = '';}} />
        <ul>{packs.map(pack => <li key={pack.id}><span><strong>{pack.id}</strong> · {pack.version}<code>{pack.manifestSha256}</code></span><button type="button" aria-label={`Remove ${pack.id}`} onClick={() => {change(); setPacks(current => current.filter(item => item.id !== pack.id));}}>Remove</button></li>)}</ul>
      </fieldset>
      <fieldset className={styles.wide} disabled={busy}><legend>Evidence · {evidence.length}/32</legend><div className={styles.evidenceControls}><label>Evidence kind<select value={kind} onChange={event => setKind(event.target.value as Evidence['kind'])}><option value="visual">Visual proof</option><option value="rights">Artwork rights</option><option value="compatibility">Compatibility check</option></select></label><input aria-label="Add evidence file" type="file" accept=".png,.json,.md" onChange={event => {void addFile(event.target.files?.[0], 'evidence'); event.target.value = '';}} /></div>
        <ul>{evidence.map(entry => <li key={entry.path}><span><strong>{entry.path}</strong> · {entry.kind}<code>{entry.sha256}</code></span><button type="button" aria-label={`Remove ${entry.path}`} onClick={() => {change(); setEvidence(current => current.filter(item => item.path !== entry.path));}}>Remove</button></li>)}</ul>
      </fieldset>
    </div>
    <footer className={styles.footer}><p role="status" aria-live="polite">{busy ? 'Reading and fingerprinting your file…' : notice}</p><div><button type="button" onClick={validate} disabled={busy}>Check proposal</button><button type="button" onClick={download} disabled={!reviewed || busy}>Export proposal</button></div><details><summary>Import & review details</summary><label>Import an existing proposal<input type="file" accept=".json,application/json" disabled={busy} onChange={event => {void addFile(event.target.files?.[0], 'proposal'); event.target.value = '';}} /></label><p>Files stay on this device. This checks the proposal envelope and fingerprints uploaded bytes. It does not check artwork rights, pack compatibility, or repository permissions. A reviewer must verify the original files before any release.</p><p>Review tools: <code>node scripts/charmville/contribution-validate.mjs proposal.json</code>. Full pack verification and approval remain a separate review step.</p></details></footer>
  </section>;
}
