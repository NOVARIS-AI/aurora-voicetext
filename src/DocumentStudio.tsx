import { useEffect, useRef, useState } from 'react';
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import { FileUp, FileText, Sparkles, Send, Download, RotateCcw, X, WandSparkles, MessageCircle, Check, AlertCircle } from 'lucide-react';

type AssistInput = { text: string; instruction: string; task: string };
type Message = { id: string; role: 'user' | 'assistant'; text: string };
type Props = { onAssist: (input: AssistInput) => Promise<string> };

const STORAGE_KEY = 'aurora-voicetext-document-studio-v1';
const DOCX_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

async function extractDocx(file: File): Promise<string> {
  if (file.size > 20 * 1024 * 1024) throw new Error('Please choose a DOCX file smaller than 20 MB.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65558); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('This does not look like a valid DOCX file.');
  const count = view.getUint16(end + 10, true);
  let cursor = view.getUint32(end + 16, true);
  let xmlBytes: Uint8Array | null = null;
  for (let i = 0; i < count; i++) {
    if (view.getUint32(cursor, true) !== 0x02014b50) break;
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const entryName = new TextDecoder().decode(bytes.slice(cursor + 46, cursor + 46 + nameLength));
    if (entryName === 'word/document.xml') {
      if (uncompressedSize > 15 * 1024 * 1024) throw new Error('This Word document contains too much text to open safely.');
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = bytes.slice(start, start + compressedSize);
      if (method === 0) xmlBytes = compressed;
      else if (method === 8) {
        const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        xmlBytes = new Uint8Array(await new Response(stream).arrayBuffer());
      } else throw new Error('This DOCX uses an unsupported compression method.');
      break;
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (!xmlBytes) throw new Error('The DOCX file is missing its main document content.');
  const xml = new DOMParser().parseFromString(new TextDecoder().decode(xmlBytes), 'application/xml');
  if (xml.querySelector('parsererror')) throw new Error('The document content could not be read.');
  const paragraphs = Array.from(xml.getElementsByTagNameNS(DOCX_NS, 'p')).map(paragraph => {
    let value = '';
    const walk = (node: Node) => {
      node.childNodes.forEach(child => {
        if (child.nodeType === Node.ELEMENT_NODE) {
          const element = child as Element;
          if (element.namespaceURI === DOCX_NS && element.localName === 't') value += element.textContent || '';
          else if (element.namespaceURI === DOCX_NS && element.localName === 'tab') value += '    ';
          else if (element.namespaceURI === DOCX_NS && element.localName === 'br') value += '\n';
          else walk(child);
        }
      });
    };
    walk(paragraph);
    const style = paragraph.getElementsByTagNameNS(DOCX_NS, 'pStyle')[0]?.getAttributeNS(DOCX_NS, 'val') || '';
    const trimmed = value.trim();
    if (!trimmed) return '';
    if (/^Title$/i.test(style)) return '# ' + trimmed;
    if (/^Heading1$/i.test(style)) return '## ' + trimmed;
    if (/^Heading2$/i.test(style)) return '### ' + trimmed;
    return trimmed;
  }).filter(Boolean);
  return paragraphs.join('\n\n');
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export default function DocumentStudio({ onAssist }: Props) {
  const [name, setName] = useState('Untitled document');
  const [text, setText] = useState('');
  const [savedText, setSavedText] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [proposal, setProposal] = useState('');
  const [previewOpen, setPreviewOpen] = useState(false);
  const [pendingTask, setPendingTask] = useState('chat');
  const [undoText, setUndoText] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (saved && typeof saved.text === 'string') {
        setName(typeof saved.name === 'string' ? saved.name : 'Untitled document');
        setText(saved.text);
        setSavedText(saved.text);
      }
    } catch { /* Ignore an invalid local draft and keep the empty editor usable. */ }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ name, text, savedAt: Date.now() }));
        setSavedText(text);
      } catch { setStatus('This document is too large for local browser storage. Please export a copy.'); }
    }, 450);
    return () => window.clearTimeout(timer);
  }, [name, text]);

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [messages, busy]);

  const importFile = async (file?: File) => {
    if (!file) return;
    setImportBusy(true); setError(''); setStatus('');
    try {
      const lower = file.name.toLowerCase();
      let imported = '';
      if (lower.endsWith('.docx')) imported = await extractDocx(file);
      else if (lower.endsWith('.txt') || lower.endsWith('.md')) imported = await file.text();
      else throw new Error('Choose a Word document (.docx), text file (.txt) or Markdown file (.md).');
      if (!imported.trim()) throw new Error('No readable text was found in this file.');
      setName(file.name.replace(/\.(docx|txt|md)$/i, '') || 'Imported document');
      setText(imported);
      setProposal('');
      setPreviewOpen(false);
      setUndoText(null);
      setMessages([{ id: String(Date.now()), role: 'assistant', text: 'Your document is open. You can edit it directly, or tell me what you want improved.' }]);
      setStatus('Document imported. Your original file has not been changed.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not import this document.'); }
    finally { setImportBusy(false); if (fileRef.current) fileRef.current.value = ''; }
  };

  const runAssist = async (prompt: string, task = 'chat') => {
    const current = text.trim();
    if (!current) { setError('Import or write a document first.'); return; }
    if (current.length > 22000) { setError('For now, AI editing supports documents up to 22,000 characters. Split a longer document into sections.'); return; }
    setError(''); setBusy(true); setProposal(''); setPendingTask(task);
    setMessages(items => [...items, { id: String(Date.now()), role: 'user', text: prompt }]);
    try {
      const result = await onAssist({ text: current, instruction: prompt, task });
      if (!result?.trim()) throw new Error('The AI returned an empty response.');
      setProposal(task === 'chat' ? '' : result.trim());
      setPreviewOpen(task !== 'chat');
      setMessages(items => [...items, { id: String(Date.now() + 1), role: 'assistant', text: task === 'chat' ? result.trim() : 'Your revised document is ready. I opened the full preview so you can review every paragraph before applying it.' }]);
    } catch (reason) {
      setMessages(items => [...items, { id: String(Date.now() + 2), role: 'assistant', text: reason instanceof Error ? reason.message : 'The AI assistant is unavailable right now.' }]);
    } finally { setBusy(false); }
  };

  const applyProposal = () => {
    if (!proposal) return;
    if (pendingTask === 'chat') {
      setStatus('This looks like an answer or summary, so it has not replaced your original document.');
      setProposal('');
      return;
    }
    setUndoText(text);
    setText(proposal);
    setProposal('');
    setPreviewOpen(false);
    setStatus('AI changes applied. Your previous saved copy is still available through undo in the editor.');
  };

  const exportDocx = async () => {
    if (!text.trim()) { setError('There is no document to export yet.'); return; }
    try {
      const paragraphs = text.split(/\n\s*\n/).map(block => block.trim()).filter(Boolean).map(block => {
        if (block.startsWith('### ')) return new Paragraph({ text: block.slice(4), heading: HeadingLevel.HEADING_2, spacing: { after: 140 } });
        if (block.startsWith('## ')) return new Paragraph({ text: block.slice(3), heading: HeadingLevel.HEADING_1, spacing: { after: 180 } });
        if (block.startsWith('# ')) return new Paragraph({ text: block.slice(2), heading: HeadingLevel.TITLE, spacing: { after: 260 } });
        return new Paragraph({ children: [new TextRun(block)], spacing: { after: 160 } });
      });
      const doc = new Document({ sections: [{ properties: {}, children: paragraphs }] });
      const blob = await Packer.toBlob(doc);
      downloadBlob(blob, (name.replace(/\.(docx|txt|md)$/i, '') || 'aurora-document') + '.docx');
      setStatus('DOCX export created.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not export DOCX.'); }
  };

  const saveAsText = () => {
    downloadBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), (name || 'aurora-document') + '.txt');
    setStatus('Text copy exported.');
  };

  return (
    <section className="page-content document-studio">
      <div className="page-heading">
        <div className="eyebrow"><FileText size={14}/> DOCUMENT INTELLIGENCE</div>
        <h1>Document Studio</h1>
        <p>Import a Word document, refine the writing, organise its structure and export a fresh copy. Your original file stays untouched.</p>
      </div>
      <div className="document-toolbar card">
        <div className="document-name-wrap"><FileText size={18}/><input aria-label="Document name" value={name} onChange={event => setName(event.target.value)} maxLength={100}/><span className="document-save-state">{text === savedText ? <><Check size={13}/> Saved locally</> : 'Saving…'}</span></div>
        <div className="document-toolbar-actions">
          <button className="secondary small-button" type="button" onClick={() => fileRef.current?.click()} disabled={importBusy}>{importBusy ? 'Opening…' : <><FileUp size={15}/> Import DOCX</>}</button>
          <button className="secondary small-button" type="button" onClick={saveAsText} disabled={!text.trim()}><Download size={15}/> TXT</button>
          <button className="primary small-button" type="button" onClick={() => void exportDocx()} disabled={!text.trim()}><Download size={15}/> Export DOCX</button>
        </div>
        <input ref={fileRef} className="hidden-input" type="file" accept=".docx,.txt,.md,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown" onChange={event => void importFile(event.currentTarget.files?.[0])}/>
      </div>
      <div className="document-chat-workspace">
        <section className="card document-ai-card document-ai-chat-first">
          <div className="document-ai-heading"><span><Sparkles size={19}/></span><div><small>DOCUMENT INTELLIGENCE</small><h2>AURORA DOCUMENT AI</h2><p>{text.trim() ? 'Your document is attached. Ask questions, request changes or explore the content.' : 'Start a conversation, or import a document to give AURORA context.'}</p></div></div>
          {text.trim() && <div className="document-attached-file"><FileText size={16}/><span><strong>{name || 'Untitled document'}</strong><small>{text.length.toLocaleString()} characters · saved on this device</small></span><button type="button" onClick={() => fileRef.current?.click()} aria-label="Replace attached document"><FileUp size={15}/></button></div>}
          <div className="document-ai-suggestions">
            {['Summarise this document','Explain the key points','Improve the writing','Find errors and inconsistencies'].map((prompt, index) => <button key={prompt} type="button" disabled={busy || !text.trim()} onClick={() => void runAssist(prompt, index === 2 || index === 3 ? 'rewrite' : 'chat')}>{prompt}</button>)}
          </div>
          <div className="document-chat-thread document-chat-thread-main" aria-live="polite">
            {messages.length === 0 && <div className="document-chat-empty"><span className="document-chat-orb"><Sparkles size={27}/></span><strong>What would you like to work on?</strong><span>Ask AURORA to explain, summarise, proofread, rewrite or organise your document. You stay in control of every change.</span></div>}
            {messages.map(message => <div className={'document-chat-message ' + message.role} key={message.id}><small>{message.role === 'user' ? 'YOU' : 'AURORA'}</small><p>{message.text}</p></div>)}
            {busy && <div className="document-chat-message assistant"><small>AURORA</small><p>Reviewing your document…</p></div>}
            <div ref={chatEndRef}/>
          </div>
          <form className="document-chat-composer document-chat-composer-main" onSubmit={event => { event.preventDefault(); const prompt = chatInput.trim(); if (!prompt || busy) return; setChatInput(''); void runAssist(prompt, /rewrite|reorgan|arrange|proofread|correct|edit|improve|make this/i.test(prompt) ? 'rewrite' : 'chat'); }}>
            <textarea value={chatInput} onChange={event => setChatInput(event.target.value)} placeholder={text.trim() ? 'Message AURORA about your document…' : 'Ask AURORA anything about a document…'} rows={2} aria-label="Message AURORA"/>
            <button className="primary" type="submit" disabled={busy || !chatInput.trim()} aria-label="Send message">{busy ? <span className="document-spinner"/> : <Send size={17}/>}</button>
          </form>
          <p className="document-privacy-note"><AlertCircle size={13}/> When a document is attached, its text is sent to the configured AI service when you ask for help. Avoid sensitive information.</p>
        </section>
        <details className="card document-context-panel">
          <summary><span><FileText size={16}/> Document workspace</span><span>{text.trim() ? 'Open to view or edit the full text' : 'Open to write or paste text'} <span aria-hidden="true">＋</span></span></summary>
          <div className="document-context-body">
            <div className="document-panel-heading"><div><small>EDITABLE DOCUMENT</small><h2>{name || 'Untitled document'}</h2></div><span>{text.length.toLocaleString()} characters</span></div>
            <textarea ref={editorRef} className="document-editor" value={text} onChange={event => { setText(event.target.value); setProposal(''); }} placeholder={'Import a .docx file or start writing here…\n\nUse blank lines to separate paragraphs. Start a heading with # or ##.'} spellCheck />
            <div className="document-editor-footer"><span>Autosaved on this device</span><button className="text-button" type="button" disabled={!undoText} onClick={() => { if (undoText !== null) setText(undoText); setUndoText(null); setStatus('Undid the last AI document edit.'); }}><RotateCcw size={13}/> Undo AI edit</button></div>
            <div className="document-quick-actions">
              <button type="button" onClick={() => void runAssist('Rewrite this document in clear, polished, natural language. Preserve all facts, names, dates, figures and important details. Return only the revised document.', 'rewrite')} disabled={busy || !text.trim()}><WandSparkles size={15}/> Rewrite</button>
              <button type="button" onClick={() => void runAssist('Organise this document with a logical title, clear sections, useful headings and well-ordered paragraphs. Preserve all information and do not invent facts. Return only the reorganised document.', 'organise')} disabled={busy || !text.trim()}><FileText size={15}/> Organise</button>
              <button type="button" onClick={() => void runAssist('Correct grammar, spelling and punctuation while preserving the writer’s meaning, voice and all factual details. Return only the corrected document.', 'rewrite')} disabled={busy || !text.trim()}><Check size={15}/> Proofread</button>
              <button type="button" onClick={() => void runAssist('Create a concise summary of this document. Keep the key facts and conclusions. Clearly label it as a summary.', 'chat')} disabled={busy || !text.trim()}><Sparkles size={15}/> Summarise</button>
            </div>
          </div>
        </details>
      </div>
      {previewOpen && proposal && <div className="document-preview-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setPreviewOpen(false); }}>
        <section className="document-preview-modal" role="dialog" aria-modal="true" aria-labelledby="document-preview-title">
          <header className="document-preview-header">
            <div className="document-preview-brand"><span><Sparkles size={18}/></span><div><small>AURORA AI · DOCUMENT REVIEW</small><h2 id="document-preview-title">Your revised document</h2><p>Review the complete result before applying changes.</p></div></div>
            <button className="document-preview-close" type="button" aria-label="Close preview" onClick={() => setPreviewOpen(false)}><X size={19}/></button>
          </header>
          <div className="document-preview-meta"><span><FileText size={14}/>{name || 'Untitled document'}</span><span>{proposal.length.toLocaleString()} characters</span><span>{proposal.trim() ? proposal.trim().split(/\\s+/).length.toLocaleString() : 0} words</span></div>
          <article className="document-preview-content"><pre>{proposal}</pre></article>
          <footer className="document-preview-footer"><span>Your original document remains unchanged until you apply this version.</span><div><button className="secondary small-button" type="button" onClick={() => { setProposal(''); setPreviewOpen(false); setStatus('AI suggestion discarded.'); }}>Discard</button><button className="primary small-button" type="button" onClick={applyProposal}><Check size={15}/> Apply to document</button></div></footer>
        </section>
      </div>}
      {status && <div className="status-message" role="status">{status}</div>}
      {error && <div className="error-message" role="alert"><span>{error}</span><button type="button" onClick={() => setError('')} aria-label="Dismiss error"><X size={15}/></button></div>}
    </section>
  );
}
