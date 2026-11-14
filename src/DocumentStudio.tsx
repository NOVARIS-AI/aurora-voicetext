import { useEffect, useRef, useState } from 'react';
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import { ArrowLeft, FileUp, FileText, Sparkles, Send, Download, RotateCcw, Redo2, X, WandSparkles, Check, AlertCircle, Save, Bold, Italic, Underline, List, ListOrdered, Heading1, Heading2, AlignLeft, AlignCenter, AlignRight, Search, Replace, Printer, Trash2, Table, Link2, Undo2 } from 'lucide-react';

type AssistInput = { text: string; instruction: string; task: string };
type Message = { id: string; role: 'user' | 'assistant'; text: string };
type Props = { onAssist: (input: AssistInput) => Promise<string>; onSaveToLibrary: (record: { name: string; text: string }) => void; workspaceId: string; onBack: () => void };

const STORAGE_KEY = 'aurora-voicetext-document-studio-v1';
const workspaceStorageKey = (id: string) => STORAGE_KEY + ':' + id;
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

export default function DocumentStudio({ onAssist, onSaveToLibrary, workspaceId, onBack }: Props) {
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
  const [undoStack, setUndoStack] = useState<string[]>([]);
  const [redoStack, setRedoStack] = useState<string[]>([]);
  const [findText, setFindText] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [fontSize, setFontSize] = useState(12);
  const [zoom, setZoom] = useState(100);
  const [textAlign, setTextAlign] = useState<'left'|'center'|'right'|'justify'>('left');
  const fileRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(workspaceStorageKey(workspaceId)) || (workspaceId === 'legacy-work' ? localStorage.getItem(STORAGE_KEY) : null) || 'null');
      if (saved && typeof saved.text === 'string') {
        setName(typeof saved.name === 'string' ? saved.name : 'Untitled document');
        setText(saved.text);
        setSavedText(saved.text);
        setMessages(Array.isArray(saved.messages) ? saved.messages : []);
        setProposal(typeof saved.proposal === 'string' ? saved.proposal : '');
      } else {
        setName('Untitled document'); setText(''); setSavedText(''); setMessages([]); setProposal('');
      }
    } catch { /* Ignore an invalid local draft and keep the empty editor usable. */ }
  }, [workspaceId]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        localStorage.setItem(workspaceStorageKey(workspaceId), JSON.stringify({ name, text, messages, proposal, savedAt: Date.now() }));
        setSavedText(text);
      } catch { setStatus('This document is too large for local browser storage. Please export a copy.'); }
    }, 180);
    return (
    <section className="document-studio document-fullpage">
      <header className="document-appbar">
        <button className="document-back-button" type="button" onClick={onBack}><ArrowLeft size={17}/> Back to workspace</button>
        <div className="document-appbar-title"><FileText size={18}/><span>AURORA Docs</span><small>DOCUMENT EDITOR</small></div>
        <span className="document-save-state">{text === savedText ? <><Check size={13}/> Saved locally</> : 'Saving…'}</span>
      </header>

      <div className="document-toolbar card">
        <div className="document-name-wrap"><FileText size={18}/><input aria-label="Document name" value={name} onChange={event => setName(event.target.value)} maxLength={100}/></div>
        <div className="document-toolbar-actions">
          <button className="secondary small-button" type="button" onClick={createNewDocument}><FileText size={15}/> New</button>
          <button className="secondary small-button" type="button" onClick={() => fileRef.current?.click()} disabled={importBusy}>{importBusy ? 'Opening…' : <><FileUp size={15}/> Open</>}</button>
          <button className="secondary small-button" type="button" onClick={() => { if (!text.trim()) return; onSaveToLibrary({ name: name.trim() || 'Untitled document', text: text.trim() }); setStatus('Document saved to your Library.'); }} disabled={!text.trim()}><Save size={15}/> Save</button>
          <button className="secondary small-button" type="button" onClick={saveAsText} disabled={!text.trim()}><Download size={15}/> TXT</button>
          <button className="primary small-button" type="button" onClick={() => void exportDocx()} disabled={!text.trim()}><Download size={15}/> DOCX</button>
          <button className="secondary small-button" type="button" onClick={() => window.print()} disabled={!text.trim()}><Printer size={15}/> Print / PDF</button>
          <button className="secondary small-button document-delete-button" type="button" onClick={createNewDocument} title="Start a blank document"><Trash2 size={15}/></button>
        </div>
        <input ref={fileRef} className="hidden-input" type="file" accept=".docx,.txt,.md,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown" onChange={event => void importFile(event.currentTarget.files?.[0])}/>
      </div>

      <div className="document-ribbon" role="toolbar" aria-label="Document formatting">
        <div className="document-ribbon-group">
          <button type="button" title="Undo" aria-label="Undo" disabled={!undoStack.length} onClick={undoDocument}><Undo2 size={16}/></button>
          <button type="button" title="Redo" aria-label="Redo" disabled={!redoStack.length} onClick={redoDocument}><Redo2 size={16}/></button>
        </div>
        <div className="document-ribbon-group">
          <button type="button" title="Bold" aria-label="Bold" onClick={() => wrapSelection('**')}><Bold size={16}/></button>
          <button type="button" title="Italic" aria-label="Italic" onClick={() => wrapSelection('*')}><Italic size={16}/></button>
          <button type="button" title="Underline" aria-label="Underline" onClick={() => wrapSelection('<u>','</u>')}><Underline size={16}/></button>
          <select aria-label="Text size" value={fontSize} onChange={event => setFontSize(Number(event.target.value))}>{[10,11,12,13,14,16,18,20,24,28,32].map(size=><option key={size} value={size}>{size} pt</option>)}</select>
        </div>
        <div className="document-ribbon-group">
          <button type="button" title="Heading 1" aria-label="Heading 1" onClick={() => prefixCurrentLine('# ')}><Heading1 size={17}/></button>
          <button type="button" title="Heading 2" aria-label="Heading 2" onClick={() => prefixCurrentLine('## ')}><Heading2 size={17}/></button>
          <button type="button" title="Bulleted list" aria-label="Bulleted list" onClick={() => prefixCurrentLine('- ')}><List size={17}/></button>
          <button type="button" title="Numbered list" aria-label="Numbered list" onClick={() => prefixCurrentLine('1. ')}><ListOrdered size={17}/></button>
          <button type="button" title="Insert table" aria-label="Insert table" onClick={insertTable}><Table size={16}/></button>
          <button type="button" title="Insert link" aria-label="Insert link" onClick={() => wrapSelection('[', '](https://)')}><Link2 size={16}/></button>
        </div>
        <div className="document-ribbon-group">
          <button type="button" title="Align left" aria-label="Align left" className={textAlign==='left'?'selected':''} onClick={() => setTextAlign('left')}><AlignLeft size={16}/></button>
          <button type="button" title="Align center" aria-label="Align center" className={textAlign==='center'?'selected':''} onClick={() => setTextAlign('center')}><AlignCenter size={16}/></button>
          <button type="button" title="Align right" aria-label="Align right" className={textAlign==='right'?'selected':''} onClick={() => setTextAlign('right')}><AlignRight size={16}/></button>
          <select aria-label="Page zoom" value={zoom} onChange={event => setZoom(Number(event.target.value))}>{[75,85,100,110,125,150].map(value=><option key={value} value={value}>{value}%</option>)}</select>
        </div>
      </div>

      <div className="document-findbar">
        <label><Search size={15}/><input value={findText} onChange={event => setFindText(event.target.value)} placeholder="Find in document"/></label>
        <label><Replace size={15}/><input value={replaceText} onChange={event => setReplaceText(event.target.value)} placeholder="Replace with"/></label>
        <button className="secondary small-button" type="button" onClick={replaceAll} disabled={!findText}><Replace size={14}/> Replace all</button>
      </div>

      <div className="document-page-workspace">
        <div className="document-page-ruler"><span>PAGE {Math.max(1, Math.ceil(text.length / 3200))}</span><span>{text.trim() ? text.trim().split(/\s+/).length : 0} words · {text.length.toLocaleString()} characters</span></div>
        <div className="document-paper-wrap" style={{ transform: 'scale(' + (zoom / 100) + ')' }}>
          <div className="document-paper">
            <input className="document-paper-title" aria-label="Document title" value={name} onChange={event => setName(event.target.value)} placeholder="Document title"/>
            <textarea ref={editorRef} className="document-editor document-paper-editor" value={text} style={{ fontSize: fontSize + 'pt', textAlign }} onChange={event => updateDocumentText(event.target.value)} onBlur={() => { try { localStorage.setItem(workspaceStorageKey(workspaceId), JSON.stringify({ name, text, messages, proposal, savedAt: Date.now() })); setSavedText(text); } catch {} }} placeholder={'Start writing your document here…\n\nUse the toolbar for headings, lists, emphasis, tables and links. Your work is saved automatically.'} spellCheck />
            <div className="document-paper-footer"><span>AURORA Docs</span><span>{Math.max(1, Math.ceil(text.length / 3200))}</span></div>
          </div>
        </div>
      </div>

      <details className="document-ai-drawer">
        <summary><span><Sparkles size={16}/> AURORA Document AI</span><span>Ask questions, summarise, proofread or rewrite <span aria-hidden="true">＋</span></span></summary>
        <div className="document-ai-drawer-body">
          <div className="document-ai-heading"><span><Sparkles size={19}/></span><div><small>DOCUMENT INTELLIGENCE</small><h2>AURORA DOCUMENT AI</h2><p>{text.trim() ? 'Your document is attached. Ask questions or request edits; review proposed changes before applying.' : 'Start a conversation, or write a document to give AURORA context.'}</p></div></div>
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
          <div className="document-quick-actions">
            <button type="button" onClick={() => void runAssist('Rewrite this document in clear, polished, natural language. Preserve all facts, names, dates, figures and important details. Return only the revised document.', 'rewrite')} disabled={busy || !text.trim()}><WandSparkles size={15}/> Rewrite</button>
            <button type="button" onClick={() => void runAssist('Organise this document with a logical title, clear sections, useful headings and well-ordered paragraphs. Preserve all information and do not invent facts. Return only the reorganised document.', 'organise')} disabled={busy || !text.trim()}><FileText size={15}/> Organise</button>
            <button type="button" onClick={() => void runAssist('Correct grammar, spelling and punctuation while preserving the writer’s meaning, voice and all factual details. Return only the corrected document.', 'rewrite')} disabled={busy || !text.trim()}><Check size={15}/> Proofread</button>
            <button type="button" onClick={() => void runAssist('Create a concise summary of this document. Keep the key facts and conclusions. Clearly label it as a summary.', 'chat')} disabled={busy || !text.trim()}><Sparkles size={15}/> Summarise</button>
          </div>
          <p className="document-privacy-note"><AlertCircle size={13}/> When you ask for help, the document text is sent to the configured AI service. Avoid sensitive information.</p>
        </div>
      </details>

      {previewOpen && proposal && <div className="document-preview-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setPreviewOpen(false); }}>
        <section className="document-preview-modal" role="dialog" aria-modal="true" aria-labelledby="document-preview-title">
          <header className="document-preview-header">
            <div className="document-preview-brand"><span><Sparkles size={18}/></span><div><small>AURORA AI · DOCUMENT REVIEW</small><h2 id="document-preview-title">Your revised document</h2><p>Review the complete result before applying changes.</p></div></div>
            <button className="document-preview-close" type="button" aria-label="Close preview" onClick={() => setPreviewOpen(false)}><X size={19}/></button>
          </header>
          <div className="document-preview-meta"><span><FileText size={14}/>{name || 'Untitled document'}</span><span>{proposal.length.toLocaleString()} characters</span><span>{proposal.trim() ? proposal.trim().split(/\s+/).length.toLocaleString() : 0} words</span></div>
          <article className="document-preview-content"><pre>{proposal}</pre></article>
          <footer className="document-preview-footer"><span>Your original document remains unchanged until you apply it.</span><div><button className="secondary small-button" type="button" onClick={() => { setProposal(''); setPreviewOpen(false); setStatus('AI suggestion discarded.'); }}>Discard</button><button className="primary small-button" type="button" onClick={applyProposal}><Check size={15}/> Apply to document</button></div></footer>
        </section>
      </div>}
      {status && <div className="status-message" role="status">{status}</div>}
      {error && <div className="error-message" role="alert"><span>{error}</span><button type="button" onClick={() => setError('')} aria-label="Dismiss error"><X size={15}/></button></div>}
    </section>
  );
}
