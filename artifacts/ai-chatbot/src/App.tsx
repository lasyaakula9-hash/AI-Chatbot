import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, Command, Lightbulb, Menu, MessageSquareText, MoreHorizontal, Plus, Sparkles, StopCircle, Trash2, X } from 'lucide-react';

type Role = 'user' | 'assistant';
type ChatMessage = { id: string; role: Role; content: string; createdAt: string };
type Conversation = { id: string; title: string; updatedAt: string; messages: ChatMessage[] };
const STORAGE_KEY = 'atelier-chat-conversations-v1';

const starterPrompts = [
  { icon: Lightbulb, label: 'Untangle an idea', prompt: 'Help me think through an idea I can’t quite articulate yet.' },
  { icon: MessageSquareText, label: 'Write something', prompt: 'Help me write a thoughtful note that sounds like me.' },
  { icon: ArrowDown, label: 'Learn a new thing', prompt: 'Explain a surprisingly useful idea I probably haven’t heard before.' },
];

function createId() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function readConversations(): Conversation[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data.filter((item): item is Conversation =>
      item && typeof item.id === 'string' && typeof item.title === 'string' &&
      typeof item.updatedAt === 'string' && Array.isArray(item.messages),
    );
  } catch {
    return [];
  }
}

function formatGroup(dateString: string) {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return 'Earlier';
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  if (day === start) return 'Today';
  if (day === start - 86400000) return 'Yesterday';
  return 'Earlier';
}

function App() {
  const [conversations, setConversations] = useState<Conversation[]>(readConversations);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [mobileOpen, setMobileOpen] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamError, setStreamError] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const activeConversation = conversations.find((chat) => chat.id === activeId) ?? null;
  const messages = activeConversation?.messages ?? [];

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations)); } catch { /* Browser storage may be unavailable. */ }
  }, [conversations]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, messages.at(-1)?.content]);

  const createConversation = useCallback(() => {
    const now = new Date().toISOString();
    const chat: Conversation = { id: createId(), title: 'New conversation', updatedAt: now, messages: [] };
    setConversations((current) => [chat, ...current]);
    setActiveId(chat.id);
    setDraft('');
    setStreamError('');
    setMobileOpen(false);
    window.setTimeout(() => textareaRef.current?.focus(), 40);
  }, []);

  const chooseConversation = (id: string) => {
    if (isStreaming) abortRef.current?.abort();
    setActiveId(id);
    setStreamError('');
    setMobileOpen(false);
    setDraft('');
  };

  const removeConversation = (id: string) => {
    setConversations((current) => current.filter((chat) => chat.id !== id));
    if (activeId === id) {
      const next = conversations.find((chat) => chat.id !== id);
      setActiveId(next?.id ?? null);
    }
    setDeleteTarget(null);
  };

  const updateConversation = (id: string, updater: (chat: Conversation) => Conversation) => {
    setConversations((current) => current.map((chat) => chat.id === id ? updater(chat) : chat));
  };

  const submitPrompt = async (rawPrompt: string, baseConversation?: Conversation) => {
    const prompt = rawPrompt.trim();
    if (!prompt || isStreaming) return;
    let conversation = baseConversation ?? activeConversation;
    if (!conversation) {
      const now = new Date().toISOString();
      conversation = { id: createId(), title: prompt.slice(0, 42) || 'New conversation', updatedAt: now, messages: [] };
      setConversations((current) => [conversation!, ...current]);
      setActiveId(conversation.id);
    }
    const targetId = conversation.id;
    const now = new Date().toISOString();
    const userMessage: ChatMessage = { id: createId(), role: 'user', content: prompt, createdAt: now };
    const assistantMessage: ChatMessage = { id: createId(), role: 'assistant', content: '', createdAt: new Date().toISOString() };
    const nextMessages = [...conversation.messages, userMessage, assistantMessage];
    updateConversation(targetId, (chat) => ({
      ...chat,
      title: chat.messages.length ? chat.title : prompt.length > 42 ? `${prompt.slice(0, 39)}…` : prompt,
      updatedAt: now,
      messages: nextMessages,
    }));
    setDraft('');
    setStreamError('');
    setIsStreaming(true);
    const controller = new AbortController();
    abortRef.current = controller;
    const requestMessages = nextMessages.filter((message) => message.content.trim()).slice(0, 30)
      .map(({ role, content }) => ({ role, content }));

    try {
      const response = await fetch('/api/gemini/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ messages: requestMessages }),
        signal: controller.signal,
      });
      if (!response.ok) {
        let detail = `The assistant couldn’t respond (${response.status}).`;
        try {
          const payload = await response.json();
          if (typeof payload?.error === 'string') detail = payload.error;
        } catch { /* Keep the status fallback. */ }
        throw new Error(detail);
      }
      if (!response.body) throw new Error('This response could not be streamed. Please try again.');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finished = false;
      const processFrame = (frame: string) => {
        const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
        if (!data) return;
        try {
          const event = JSON.parse(data) as { content?: string; done?: boolean; error?: string };
          if (event.error) throw new Error(event.error);
          if (event.content) {
            updateConversation(targetId, (chat) => ({
              ...chat,
              updatedAt: new Date().toISOString(),
              messages: chat.messages.map((message) => message.id === assistantMessage.id
                ? { ...message, content: message.content + event.content }
                : message),
            }));
          }
          if (event.done) finished = true;
        } catch (error) {
          if (error instanceof Error && !error.message.startsWith('Unexpected token') && !error.message.includes('JSON')) throw error;
        }
      };
      while (!finished) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() ?? '';
        for (const frame of frames) processFrame(frame);
      }
      if (buffer.trim()) processFrame(buffer);
      reader.releaseLock();
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return;
      setStreamError(error instanceof Error ? error.message : 'Something went wrong. Please try again.');
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setIsStreaming(false);
      }
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submitPrompt(draft);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (draft.trim()) void submitPrompt(draft);
    }
  };

  const stopStreaming = () => {
    abortRef.current?.abort();
    setIsStreaming(false);
  };

  const groupedConversations = useMemo(() => {
    const groups: Record<string, Conversation[]> = { Today: [], Yesterday: [], Earlier: [] };
    conversations.forEach((chat) => groups[formatGroup(chat.updatedAt)].push(chat));
    return groups;
  }, [conversations]);

  const retryLast = () => {
    if (!activeConversation) return;
    const lastUser = [...activeConversation.messages].reverse().find((message) => message.role === 'user');
    if (!lastUser) return;
    const baseConversation = {
      ...activeConversation,
      messages: activeConversation.messages.filter((message) => message.id !== lastUser.id && message.content.length > 0),
    };
    updateConversation(activeConversation.id, (chat) => ({ ...chat, messages: baseConversation.messages }));
    setStreamError('');
    void submitPrompt(lastUser.content, baseConversation);
  };

  return (
    <div className="app-shell noise flex w-full overflow-hidden">
      {mobileOpen && <button aria-label="Close navigation" data-testid="button-close-sidebar-overlay" onClick={() => setMobileOpen(false)} className="fixed inset-0 z-40 bg-[#2c211b]/30 md:hidden" />}
      <aside className={`sidebar flex h-[100dvh] w-[272px] shrink-0 flex-col px-4 pb-4 pt-5 ${mobileOpen ? 'sidebar-open' : ''}`}>
        <div className="mb-8 flex items-center justify-between px-1">
          <button type="button" onClick={() => { setActiveId(null); setMobileOpen(false); }} className="flex items-center gap-3 rounded-xl text-left" aria-label="Go to home" data-testid="button-home">
            <span className="brand-mark flex h-9 w-9 items-center justify-center rounded-[13px] text-[#fff9f1]"><Sparkles size={18} strokeWidth={1.8} /></span>
            <span className="font-serif text-[25px] leading-none tracking-[-.03em]">kindred</span>
          </button>
          <button className="rounded-lg p-2 text-[#7e736a] hover:bg-[#e7dfd2] md:hidden" onClick={() => setMobileOpen(false)} aria-label="Close menu" data-testid="button-close-sidebar"><X size={18} /></button>
        </div>

        <button onClick={createConversation} className="group flex w-full items-center justify-between rounded-xl border border-[#d9cbbc] bg-[#f8f3e9] px-3.5 py-3 text-[13px] font-semibold text-[#40372f] shadow-[0_1px_2px_rgba(52,39,27,.04)] transition hover:border-[#c5a995] hover:bg-[#fffaf0]" data-testid="button-new-chat">
          <span className="flex items-center gap-2.5"><Plus size={16} strokeWidth={2.2} /> New conversation</span>
          <span className="hidden items-center gap-1 rounded-md border border-[#e5ddd2] px-1.5 py-0.5 font-mono text-[9px] text-[#93877c] sm:flex"><Command size={10} /> K</span>
        </button>

        <div className="mb-2 mt-8 flex items-center justify-between px-2">
          <p className="font-mono text-[10px] font-medium uppercase tracking-[.14em] text-[#978b7e]">Your conversations</p>
          <span className="font-mono text-[10px] text-[#a69a8d]">{conversations.length || ''}</span>
        </div>
        <nav className="chat-scroll flex-1 space-y-5 overflow-y-auto pb-4" aria-label="Conversation history">
          {conversations.length === 0 ? (
            <div className="mx-1 mt-4 rounded-xl border border-dashed border-[#d5cabc] px-3 py-4 text-[12px] leading-5 text-[#8d8176]">
              A quiet little space for your thoughts. Start a conversation and it will be waiting here.
            </div>
          ) : Object.entries(groupedConversations).map(([group, items]) => items.length > 0 && (
            <div key={group}>
              <p className="mb-1.5 px-2 font-mono text-[9px] uppercase tracking-[.13em] text-[#a3978b]">{group}</p>
              <div className="space-y-0.5">
                {items.map((chat) => (
                  <div key={chat.id} className={`sidebar-item group flex items-center gap-1 rounded-lg pr-1 ${activeId === chat.id ? 'bg-[#e9dfd1] text-[#382f28]' : 'text-[#6d6259]'}`}>
                    <button onClick={() => chooseConversation(chat.id)} className="min-w-0 flex-1 truncate px-2.5 py-2 text-left text-[12px]" title={chat.title} data-testid={`button-conversation-${chat.id}`}>{chat.title}</button>
                    <button onClick={() => setDeleteTarget(chat.id)} aria-label={`Delete ${chat.title}`} className="rounded-md p-1.5 text-[#9b8e82] opacity-0 transition hover:bg-[#ddd1c2] hover:text-[#9b4634] group-hover:opacity-100 focus:opacity-100" data-testid={`button-delete-conversation-${chat.id}`}><Trash2 size={13} /></button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </nav>

        <div className="mt-auto border-t border-[#ddd3c6] pt-4">
          <div className="flex items-center gap-2.5 px-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-full border border-[#d4c2ad] bg-[#eee3d3] text-[#865744]"><Sparkles size={14} /></span>
            <div className="min-w-0">
              <p className="text-[11px] font-semibold text-[#51473e]">A little room to think</p>
              <p className="mt-0.5 text-[10px] text-[#998d80]">Your chats stay on this device</p>
            </div>
            <button aria-label="More options" title="More options" className="ml-auto rounded-md p-1.5 text-[#998d80] hover:bg-[#e7dfd2]" data-testid="button-more-options" onClick={() => window.alert('Conversation history is saved privately in this browser.')}>
              <MoreHorizontal size={16} />
            </button>
          </div>
        </div>
      </aside>

      <main className="main-panel relative flex min-w-0 flex-1 flex-col">
        <header className="z-10 flex h-[62px] shrink-0 items-center justify-between border-b border-[#e8e0d5]/75 px-4 md:px-8">
          <div className="flex items-center gap-3">
            <button onClick={() => setMobileOpen(true)} aria-label="Open navigation" data-testid="button-open-sidebar" className="rounded-lg p-2 text-[#766b61] hover:bg-[#eee8de] md:hidden"><Menu size={18} /></button>
            <div className="flex items-center gap-2">
              <span className="h-1.5 w-1.5 rounded-full bg-[#ba634a]" />
              <span className="text-[12px] font-medium text-[#695e54]">{activeConversation ? activeConversation.title : 'A thoughtful assistant'}</span>
              <ChevronDown size={13} className="text-[#a89b8e]" />
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-full border border-[#e5ddd2] bg-[#faf6ee]/80 px-2.5 py-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-[#7a9279]" />
            <span className="font-mono text-[9px] uppercase tracking-[.1em] text-[#81766b]">Here with you</span>
          </div>
        </header>

        <section className="chat-scroll flex-1 overflow-y-auto">
          {messages.length === 0 ? (
            <div className="mx-auto flex min-h-full w-full max-w-[900px] flex-col justify-center px-5 pb-16 pt-12 md:px-10 md:pb-20">
              <div className="max-w-[640px]">
                <p className="intro-enter mb-5 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[.16em] text-[#a36a51]">
                  <span className="inline-block h-px w-6 bg-[#c88d70]" /> A space for curiosity
                </p>
                <h1 className="intro-enter text-[clamp(42px,7vw,74px)] leading-[.96] tracking-[-.045em] text-[#352b25]">
                  Good questions<br /><span className="font-serif italic text-[#ad6047]">start somewhere.</span>
                </h1>
                <p className="intro-enter-delay mt-6 max-w-[450px] text-[15px] leading-[1.75] text-[#81766c]">
                  Bring a half-formed thought, a stubborn question, or just a little curiosity. We can work it out together.
                </p>
              </div>
              <div className="mt-12 grid max-w-[780px] gap-3 sm:grid-cols-3">
                {starterPrompts.map(({ icon: Icon, label, prompt }) => (
                  <button key={label} onClick={() => void submitPrompt(prompt)} className="suggestion-card group min-h-[122px] rounded-2xl border border-[#e5dbce] bg-[#f9f5ed]/80 p-4 text-left" data-testid={`button-suggestion-${label.toLowerCase().replaceAll(' ', '-')}`}>
                    <span className="mb-5 flex h-8 w-8 items-center justify-center rounded-[11px] bg-[#efe5d7] text-[#a65e44] transition group-hover:bg-[#f0ddd0]"><Icon size={16} strokeWidth={1.8} /></span>
                    <span className="block text-[12px] font-semibold text-[#54483e]">{label}</span>
                    <span className="mt-1.5 block text-[11px] leading-[1.45] text-[#96897d]">{prompt}</span>
                  </button>
                ))}
              </div>
              <p className="mt-8 font-mono text-[9px] uppercase tracking-[.14em] text-[#b0a397]">No perfect prompt required</p>
            </div>
          ) : (
            <div className="mx-auto w-full max-w-[790px] px-5 pb-10 pt-8 md:px-10 md:pt-12">
              <div className="mb-9 flex items-center gap-3">
                <span className="h-px flex-1 bg-[#e8dfd3]" />
                <span className="font-mono text-[9px] uppercase tracking-[.13em] text-[#aa9e91]">{activeConversation ? new Date(activeConversation.updatedAt).toLocaleDateString(undefined, { month: 'long', day: 'numeric' }) : 'Today'}</span>
                <span className="h-px flex-1 bg-[#e8dfd3]" />
              </div>
              <div className="space-y-8">
                {messages.map((message) => (
                  <article key={message.id} className={`message-enter ${message.role === 'user' ? 'ml-auto max-w-[80%]' : 'mr-auto w-full max-w-[690px]'}`} data-testid={`message-${message.role}-${message.id}`}>
                    {message.role === 'user' ? (
                      <div className="rounded-[20px] rounded-br-[6px] bg-[#ebe1d3] px-5 py-3.5 text-[14px] leading-[1.7] text-[#3d332b]">
                        <p className="whitespace-pre-wrap">{message.content}</p>
                      </div>
                    ) : (
                      <div className="flex gap-3.5">
                        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[12px] bg-[#f0e3d5] text-[#ad6047]"><Sparkles size={15} strokeWidth={1.8} /></span>
                        <div className="min-w-0 flex-1 pt-1">
                          <p className="mb-2 font-mono text-[9px] uppercase tracking-[.12em] text-[#a26a52]">Kindred</p>
                          {message.content ? <p className="whitespace-pre-wrap text-[14px] leading-[1.8] text-[#493f37]">{message.content}</p> : isStreaming ? (
                            <div className="flex items-center gap-1.5 py-2" aria-label="Assistant is thinking" data-testid="status-assistant-thinking">
                              <span className="typing-dot h-1.5 w-1.5 rounded-full bg-[#b2785e]" /><span className="typing-dot h-1.5 w-1.5 rounded-full bg-[#b2785e]" /><span className="typing-dot h-1.5 w-1.5 rounded-full bg-[#b2785e]" />
                            </div>
                          ) : null}
                        </div>
                      </div>
                    )}
                  </article>
                ))}
                <div ref={bottomRef} />
              </div>
            </div>
          )}
        </section>

        <div className="z-10 mx-auto w-full max-w-[850px] px-4 pb-3 pt-3 md:px-8 md:pb-6">
          {streamError && (
            <div className="mb-3 flex items-center justify-between gap-3 rounded-xl border border-[#e5c4b5] bg-[#fbede5] px-4 py-3 text-[12px] text-[#8d4634]" role="alert" data-testid="status-chat-error">
              <span>{streamError}</span>
              <button onClick={retryLast} className="shrink-0 font-semibold underline underline-offset-2" data-testid="button-retry">Try again</button>
            </div>
          )}
          <form onSubmit={handleSubmit} className="composer-shadow rounded-[22px] border border-[#e4dbcf] bg-[#fbf8f1] p-2.5">
            <label htmlFor="chat-input" className="sr-only">Ask Kindred anything</label>
            <textarea
              ref={textareaRef}
              id="chat-input"
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                event.target.style.height = 'auto';
                event.target.style.height = `${Math.min(event.target.scrollHeight, 180)}px`;
              }}
              onKeyDown={handleKeyDown}
              placeholder="Ask what’s on your mind…"
              rows={1}
              maxLength={12000}
              className="max-h-[180px] min-h-[46px] w-full resize-none border-0 bg-transparent px-3.5 py-3 text-[14px] leading-6 text-[#41372f] outline-none placeholder:text-[#a79a8c] focus:ring-0"
              data-testid="input-chat"
            />
            <div className="flex items-center justify-between px-1.5 pb-0.5">
              <span className="pl-2 text-[10px] text-[#a3978a]">A good place to start is anywhere.</span>
              {isStreaming ? (
                <button type="button" onClick={stopStreaming} className="flex h-9 items-center gap-2 rounded-xl border border-[#dfc8bc] bg-[#f6e8df] px-3.5 text-[11px] font-semibold text-[#94543e] transition hover:bg-[#f0ddd1]" data-testid="button-stop">
                  <StopCircle size={15} /> Stop
                </button>
              ) : (
                <button type="submit" disabled={!draft.trim()} className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#b75f43] text-[#fff8f0] transition hover:bg-[#a84f36] disabled:cursor-not-allowed disabled:bg-[#ded4c8] disabled:text-[#a79b8f]" aria-label="Send message" data-testid="button-send">
                  <ArrowUp size={18} strokeWidth={2.2} />
                </button>
              )}
            </div>
          </form>
          <p className="mt-2.5 text-center text-[9px] leading-4 text-[#aaa093]">Kindred can get things wrong. Keep your own good sense close.</p>
        </div>
      </main>

      {deleteTarget && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-[#33271f]/25 px-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDeleteTarget(null); }}>
          <div role="dialog" aria-modal="true" aria-labelledby="delete-title" className="w-full max-w-[360px] rounded-2xl border border-[#e5dbce] bg-[#fbf8f1] p-5 shadow-[0_18px_70px_rgba(44,31,20,.18)]">
            <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-[#f2e5dc] text-[#a9533d]"><Trash2 size={17} /></div>
            <h2 id="delete-title" className="font-serif text-[25px] text-[#392e27]">Let this one go?</h2>
            <p className="mt-2 text-[12px] leading-5 text-[#877a6e]">This conversation will be removed from this browser. There’s no undo.</p>
            <div className="mt-6 flex justify-end gap-2">
              <button onClick={() => setDeleteTarget(null)} className="rounded-lg px-3.5 py-2 text-[12px] font-semibold text-[#6c6056] hover:bg-[#f0e9de]" data-testid="button-cancel-delete">Keep it</button>
              <button onClick={() => removeConversation(deleteTarget)} className="rounded-lg bg-[#a94f39] px-3.5 py-2 text-[12px] font-semibold text-[#fff8f1] hover:bg-[#93432f]" data-testid="button-confirm-delete">Delete conversation</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
