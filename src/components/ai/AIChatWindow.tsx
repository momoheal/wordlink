'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { X, Send, Sparkles, ChevronDown, Loader2, Minus, GripVertical, Square, Plus, MessageSquare, BookOpen, FolderOpen, Trash2, PanelLeftClose, PanelLeft, Crown } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAI } from './AIProvider';
import { useSettings } from '@/context/SettingsContext';
import { readChatEvents } from '@/lib/ai/chat-events';
import { useLocale, useTranslations } from 'next-intl';

interface Message {
    role: 'user' | 'assistant';
    content: string;
    kind?: 'paywall';
    quota?: { used?: number; limit?: number };
}

interface LocalSession {
    id: string;
    title: string;
    category: number;
    word?: string;
    wordGroup?: string;
    messages: Message[];
    createdAt: Date;
    /** 已存到服务器（发出过消息）；否则是还没发消息的本地草稿，id 是本地生成的 */
    persisted: boolean;
    /** 服务器会话的消息是否已经取回（列表接口不带消息正文） */
    loaded: boolean;
}

interface ServerSession {
    id: string;
    title: string;
    category: number;
    word: string | null;
    wordGroup: string | null;
    createdAt: string;
}

const MIN_WIDTH = 480;
const MIN_HEIGHT = 500;

const generateId = () => Math.random().toString(36).substring(2) + Date.now().toString(36);

export default function AIChatWindow() {
    const { isOpen, setIsOpen, userContext, currentWord, setCurrentWord, ballPosition, currentWordGroup } = useAI();
    const { aiDefaultModel } = useSettings();
    const locale = useLocale();
    const t = useTranslations();

    const MODELS = [
        { id: 'deepseek-chat', name: 'DeepSeek Chat', description: locale === 'zh' ? '快速高效' : 'Fast & Efficient' },
        { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', description: locale === 'zh' ? '复杂推理' : 'Complex Reasoning' },
    ];

    const CATEGORY_STYLES: Record<number, { icon: React.ReactNode; label: string; color: string; bgColor: string }> = {
        1: { icon: <BookOpen size={14} />, label: locale === 'zh' ? '单词' : 'Word', color: 'text-purple-400', bgColor: 'bg-purple-500/20' },
        2: { icon: <FolderOpen size={14} />, label: locale === 'zh' ? '单词组' : 'Word Group', color: 'text-blue-400', bgColor: 'bg-blue-500/20' },
        3: { icon: <Sparkles size={14} />, label: locale === 'zh' ? '全局调用' : 'Global', color: 'text-amber-400', bgColor: 'bg-amber-500/20' },
        4: { icon: <MessageSquare size={14} />, label: locale === 'zh' ? '其他' : 'Other', color: 'text-emerald-400', bgColor: 'bg-emerald-500/20' },
    };

    // Local session state
    const [sessions, setSessions] = useState<LocalSession[]>([]);
    const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
    const currentSessionIdRef = useRef<string | null>(null);
    useEffect(() => { currentSessionIdRef.current = currentSessionId; }, [currentSessionId]);

    const [showSidebar, setShowSidebar] = useState(true);

    const [input, setInput] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [selectedModel, setSelectedModel] = useState(aiDefaultModel || 'deepseek-chat');
    const [showModelSelect, setShowModelSelect] = useState(false);
    const [streamingContent, setStreamingContent] = useState('');
    const [showModeSelect, setShowModeSelect] = useState(false);

    // Animation phases: closed -> opening -> open -> closing -> closed
    const [animState, setAnimState] = useState<'closed' | 'opening' | 'open' | 'closing'>('closed');

    const abortControllerRef = useRef<AbortController | null>(null);

    // Window State
    const [position, setPosition] = useState({ x: -1, y: -1 });
    const [size, setSize] = useState({ width: 520, height: 600 });
    const [isDragging, setIsDragging] = useState(false);
    const [isResizing, setIsResizing] = useState<string | null>(null);

    // Refs
    const containerRef = useRef<HTMLDivElement>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const dragStart = useRef({ x: 0, y: 0, posX: 0, posY: 0 });
    const lastWordRef = useRef<string | null>(null);
    const lastWordGroupRef = useRef<string | null>(null);

    // Current session
    const currentSession = sessions.find(s => s.id === currentSessionId);
    const messages = currentSession?.messages || [];
    const historyLoading = !!currentSession && currentSession.persisted && !currentSession.loaded;

    // 服务器会话列表取回之前不自动新建会话，否则打开一个聊过的词会多出一个空会话
    const [sessionsLoaded, setSessionsLoaded] = useState(false);

    // Load sessions from server
    const fetchSessions = async () => {
        try {
            const res = await fetch('/api/ai/sessions', {
                credentials: 'include'
            });
            if (res.ok) {
                const data: ServerSession[] = await res.json();
                const serverIds = new Set(data.map(s => s.id));
                setSessions(prev => {
                    // 已经取回消息的会话沿用本地那份；本地草稿和刚存上服务器的会话保留在前面
                    const known = new Map(prev.filter(s => s.persisted).map(s => [s.id, s]));
                    const localOnly = prev.filter(s => !s.persisted || (s.loaded && !serverIds.has(s.id)));
                    const server = data.map((s): LocalSession => known.get(s.id) ?? {
                        id: s.id,
                        title: s.title,
                        category: s.category,
                        word: s.word ?? undefined,
                        wordGroup: s.wordGroup ?? undefined,
                        messages: [],
                        createdAt: new Date(s.createdAt),
                        persisted: true,
                        loaded: false,
                    });
                    return [...localOnly, ...server];
                });
            }
        } catch (error) {
            console.error('Failed to load sessions:', error);
        } finally {
            setSessionsLoaded(true);
        }
    };

    useEffect(() => {
        if (isOpen) {
            fetchSessions();
        }
    }, [isOpen]);

    // 选中一个服务器会话时取回它的消息
    const loadingSessionIds = useRef(new Set<string>());
    useEffect(() => {
        const target = sessions.find(s => s.id === currentSessionId);
        if (!target || !target.persisted || target.loaded || loadingSessionIds.current.has(target.id)) return;
        const id = target.id;
        loadingSessionIds.current.add(id);
        fetch(`/api/ai/sessions/${encodeURIComponent(id)}`, { credentials: 'include' })
            .then(async res => {
                if (res.status === 404) {
                    // 已在别处删除
                    setSessions(prev => prev.filter(s => s.id !== id));
                    if (currentSessionIdRef.current === id) setCurrentSessionId(null);
                    return;
                }
                const data: { messages?: { role: string; content: string }[] } | null = res.ok ? await res.json() : null;
                const loaded = (data?.messages ?? []).map((m): Message => ({
                    role: m.role === 'user' ? 'user' : 'assistant',
                    content: m.content,
                }));
                setSessions(prev => prev.map(s => (s.id === id ? { ...s, messages: loaded, loaded: true } : s)));
            })
            .catch(() => {
                setSessions(prev => prev.map(s => (s.id === id ? { ...s, loaded: true } : s)));
            })
            .finally(() => loadingSessionIds.current.delete(id));
    }, [currentSessionId, sessions]);

    // Load window position
    useEffect(() => {
        if (typeof window === 'undefined') return;
        if (position.x !== -1) return;

        const saved = localStorage.getItem('ai-window-state');
        let loadedPos = { x: window.innerWidth - 520 - 80, y: window.innerHeight - 600 - 80 };
        let loadedSize = { width: 520, height: 600 };

        if (saved) {
            try {
                const { pos, sz } = JSON.parse(saved);
                if (sz?.width && sz?.height) loadedSize = sz;
                if (pos?.x !== undefined && pos?.y !== undefined) {
                    loadedPos = {
                        x: Math.max(0, Math.min(window.innerWidth - loadedSize.width, pos.x)),
                        y: Math.max(0, Math.min(window.innerHeight - loadedSize.height, pos.y)),
                    };
                }
            } catch { }
        }
        setSize(loadedSize);
        setPosition(loadedPos);
    }, [position.x]);

    // Save window state
    useEffect(() => {
        if (position.x >= 0 && typeof window !== 'undefined') {
            localStorage.setItem('ai-window-state', JSON.stringify({ pos: position, sz: size }));
        }
    }, [position, size]);

    // Animation logic
    useEffect(() => {
        if (isOpen && (animState === 'closed' || animState === 'closing')) {
            setAnimState('opening');
            requestAnimationFrame(() => {
                setAnimState('open');
            });
        }
    }, [isOpen]);

    const handleClose = useCallback(() => {
        setAnimState('closing');
        setTimeout(() => {
            setAnimState('closed');
            setIsOpen(false);
        }, 400);
    }, [setIsOpen]);

    // Auto-create/switch session
    useEffect(() => {
        if (!isOpen || !sessionsLoaded) return;
        if (currentWord && currentWord !== lastWordRef.current) {
            lastWordRef.current = currentWord;
            const existingSession = sessions.find(s => s.category === 1 && s.word === currentWord);
            if (existingSession) setCurrentSessionId(existingSession.id);
            else createLocalSession(1, currentWord);
        } else if (currentWordGroup && currentWordGroup !== lastWordGroupRef.current) {
            lastWordGroupRef.current = currentWordGroup;
            const existingSession = sessions.find(s => s.category === 2 && s.wordGroup === currentWordGroup);
            if (existingSession) setCurrentSessionId(existingSession.id);
            else createLocalSession(2, undefined, currentWordGroup);
        } else if (!currentSessionId && sessions.length === 0) {
            createLocalSession(3);
        } else if (!currentSessionId && sessions.length > 0) {
            setCurrentSessionId(sessions[0].id);
        }
    }, [isOpen, sessionsLoaded, currentWord, currentWordGroup, sessions.length]);

    const getGreeting = (category: number, contextData?: string) => {
        const isZh = locale === 'zh';
        const contextInfo = userContext && (userContext.historyCount > 0 || userContext.testCount > 0)
            ? (isZh
                ? `\n\n📊 我已获取你的学习数据 (${userContext.historyCount}条浏览记录, ${userContext.testCount}条测试记录)`
                : `\n\n📊 I have loaded your study data (${userContext.historyCount} history, ${userContext.testCount} test records)`)
            : '';

        if (category === 1 && contextData) {
            return isZh
                ? `👋 我们来学习单词 **${contextData}**！\n\n我可以帮你：\n- 解释含义和用法\n- 提供例句和记忆技巧\n- 比较相似词汇${contextInfo}\n\n有什么想了解的？`
                : `👋 Let's study the word **${contextData}**!\n\nI can help you with:\n- Meaning and usage\n- Examples and mnemonic tips\n- Similar words & comparisons${contextInfo}\n\nWhat would you like to know?`;
        }

        if (category === 3) {
            return isZh
                ? `👋 全局调用模式已激活！${contextInfo}\n\n我可以：\n- 分析你的整体学习情况\n- 找出薄弱环节\n- 提供个性化学习建议\n- 回答任何学习相关问题\n\n有什么想了解的吗？`
                : `👋 Global study mode activated!${contextInfo}\n\nI can:\n- Analyze your overall progress\n- Identify weak spots\n- Provide personalized study advice\n- Answer any questions\n\nHow can I help you today?`;
        }

        if (category === 2 && contextData) {
            const count = contextData.split(',').length;
            return isZh
                ? `👋 我准备好帮你复习这 **${count}** 个单词了！\n\n我可以：\n- 解释它们之间的联系\n- 提供包含这些词的串记例句\n- 分析你对这些词的掌握情况\n\n我们开始吧？`
                : `👋 Ready to review these **${count}** words!\n\nI can:\n- Explain connections between them\n- Provide connected example sentences\n- Check your mastery level\n\nShall we begin?`;
        }

        return isZh
            ? `👋 你好！我是你的英语学习助手。\n\n我可以帮助你：\n- 解释单词含义和用法\n- 提供例句和记忆技巧\n- 分析你的学习进度${contextInfo}\n\n有什么我可以帮你的吗？`
            : `👋 Hello! I am your AI English Study Assistant.\n\nI can help you:\n- Explain meanings and usages\n- Provide memory tips and examples\n- Analyze your learning progress${contextInfo}\n\nWhat would you like to explore?`;
    };

    const createLocalSession = (category: number = 4, word?: string, wordGroup?: string): LocalSession => {
        const id = generateId();
        const isZh = locale === 'zh';
        let title = isZh ? '新对话' : 'New Chat';
        if (category === 1 && word) title = isZh ? `单词: ${word}` : `Word: ${word}`;
        if (category === 2 && wordGroup) title = isZh ? '单词组学习' : 'Word Group';
        if (category === 3) title = isZh ? '全局调用' : 'Global Study';

        const initialMessage = { role: 'assistant', content: getGreeting(category, category === 1 ? word : wordGroup) } as Message;

        const newSession: LocalSession = {
            id,
            title,
            category,
            word,
            wordGroup,
            messages: [initialMessage],
            createdAt: new Date(),
            persisted: false,
            loaded: true,
        };
        setSessions(prev => [newSession, ...prev]);
        setCurrentSessionId(id);
        currentSessionIdRef.current = id;
        return newSession;
    };

    const deleteLocalSession = async (sessionId: string) => {
        const target = sessions.find(s => s.id === sessionId);
        setSessions(prev => prev.filter(s => s.id !== sessionId));
        if (currentSessionId === sessionId) {
            const remaining = sessions.filter(s => s.id !== sessionId);
            setCurrentSessionId(remaining.length > 0 ? remaining[0].id : null);
        }
        // 本地草稿从没存到服务器，不用通知
        if (!target?.persisted) return;

        try {
            await fetch(`/api/ai/sessions/${encodeURIComponent(sessionId)}`, {
                method: 'DELETE',
                credentials: 'include'
            });
        } catch (error) {
            console.error('Failed to delete session:', error);
        }
    };

    // 追加而不是整体替换：取回历史、流式回复等更新可能交错发生
    const appendMessages = (sessionId: string, added: Message[]) => {
        setSessions(prev => prev.map(s => s.id === sessionId ? { ...s, messages: [...s.messages, ...added] } : s));
    };

    // 第一条消息发出后服务器才建会话：把本地草稿换成服务器的 id 和标题，之后的消息都发到这个会话
    const adoptServerSession = (localId: string, serverId: string, title?: string) => {
        setSessions(prev => prev.map(s => s.id === localId
            ? { ...s, id: serverId, title: title || s.title, persisted: true, loaded: true }
            : s));
        if (currentSessionIdRef.current === localId) {
            currentSessionIdRef.current = serverId;
            setCurrentSessionId(serverId);
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    };

    const sendMessage = async () => {
        if (!input.trim() || isLoading || historyLoading) return;
        const newMessage = input.trim();
        const target = currentSession ?? createLocalSession(currentWord ? 1 : 3, currentWord || undefined);
        let sessionId = target.id;

        appendMessages(sessionId, [{ role: 'user', content: newMessage }]);
        setInput('');
        setIsLoading(true);
        setStreamingContent('');
        const controller = new AbortController();
        abortControllerRef.current = controller;

        let reply = '';
        let failure: Message | null = null;
        try {
            // 历史和学习数据都由服务器从数据库取，这里只发新消息和会话信息
            const response = await fetch('/api/ai/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sessionId: target.persisted ? target.id : undefined,
                    newMessage,
                    model: selectedModel,
                    category: target.category,
                    word: target.word,
                    wordGroup: target.wordGroup,
                    title: target.title,
                }),
                signal: controller.signal,
                credentials: 'include'
            });

            if (response.status === 402) {
                const data = await response.json().catch(() => null);
                failure = { role: 'assistant', content: '', kind: 'paywall', quota: { used: data?.used, limit: data?.limit } };
                return;
            }
            if (response.status === 429) {
                failure = { role: 'assistant', content: t('ai.rateLimited') };
                return;
            }
            if (!response.ok || !response.body) {
                throw new Error(`Chat request failed (${response.status})`);
            }

            for await (const event of readChatEvents(response.body)) {
                if (event.type === 'session' && event.id !== sessionId) {
                    adoptServerSession(sessionId, event.id, event.title);
                    sessionId = event.id;
                } else if (event.type === 'text') {
                    reply += event.content;
                    if (currentSessionIdRef.current === sessionId) setStreamingContent(reply);
                } else if (event.type === 'error') {
                    throw new Error('Stream interrupted');
                }
            }
        } catch (error) {
            if ((error as Error).name !== 'AbortError') {
                failure = { role: 'assistant', content: locale === 'zh' ? '抱歉，生成回复时出现错误。' : 'Sorry, an error occurred while generating a response.' };
            }
        } finally {
            // 停止或出错时保留已经生成的部分（服务器也存了这部分）
            const tail: Message[] = [];
            if (reply) tail.push({ role: 'assistant', content: reply });
            if (failure) tail.push(failure);
            if (tail.length > 0) appendMessages(sessionId, tail);
            setIsLoading(false);
            setStreamingContent('');
            abortControllerRef.current = null;
        }
    };

    const stopGeneration = () => {
        // 已生成的部分由 sendMessage 收尾时追加
        abortControllerRef.current?.abort();
    };

    const handleHeaderPointerDown = (e: React.PointerEvent) => {
        if ((e.target as HTMLElement).closest('.no-drag')) return;
        setIsDragging(true);
        dragStart.current = {
            x: e.clientX,
            y: e.clientY,
            posX: position.x,
            posY: position.y,
        };
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    };

    const handleHeaderPointerMove = (e: React.PointerEvent) => {
        if (!isDragging) return;
        const dx = e.clientX - dragStart.current.x;
        const dy = e.clientY - dragStart.current.y;
        const newX = Math.max(0, Math.min(window.innerWidth - size.width, dragStart.current.posX + dx));
        const newY = Math.max(0, Math.min(window.innerHeight - size.height, dragStart.current.posY + dy));

        if (containerRef.current) {
            containerRef.current.style.left = `${newX}px`;
            containerRef.current.style.top = `${newY}px`;
        }
    };

    const handleHeaderPointerUp = (e: React.PointerEvent) => {
        if (!isDragging) return;
        setIsDragging(false);
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);

        const currentLeft = parseFloat(containerRef.current?.style.left || '0');
        const currentTop = parseFloat(containerRef.current?.style.top || '0');

        setPosition({ x: currentLeft, y: currentTop });
    };

    const handleResizeStart = (direction: string) => (e: React.MouseEvent) => { e.preventDefault(); setIsResizing(direction); };
    const handleMouseMove = useCallback((e: MouseEvent) => {
        if (!isResizing) return;
        let newWidth = size.width, newHeight = size.height, newX = position.x, newY = position.y;
        if (isResizing.includes('e')) newWidth = Math.max(MIN_WIDTH, e.clientX - position.x);
        if (isResizing.includes('w')) { const d = position.x - e.clientX; newWidth = Math.max(MIN_WIDTH, size.width + d); if (newWidth > MIN_WIDTH) newX = e.clientX; }
        if (isResizing.includes('s')) newHeight = Math.max(MIN_HEIGHT, e.clientY - position.y);
        if (isResizing.includes('n')) { const d = position.y - e.clientY; newHeight = Math.max(MIN_HEIGHT, size.height + d); if (newHeight > MIN_HEIGHT) newY = e.clientY; }
        setSize({ width: newWidth, height: newHeight });
        setPosition({ x: newX, y: newY });
    }, [isResizing, position, size]);
    const handleMouseUp = useCallback(() => setIsResizing(null), []);
    useEffect(() => {
        if (isResizing) { window.addEventListener('mousemove', handleMouseMove); window.addEventListener('mouseup', handleMouseUp); return () => { window.removeEventListener('mousemove', handleMouseMove); window.removeEventListener('mouseup', handleMouseUp); }; }
    }, [isResizing, handleMouseMove, handleMouseUp]);

    useEffect(() => { if (aiDefaultModel) setSelectedModel(aiDefaultModel); }, [aiDefaultModel]);
    useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, streamingContent]);
    useEffect(() => { if (animState === 'open') inputRef.current?.focus(); }, [animState]);

    const effectiveAnimState = (isOpen && animState === 'closed') ? 'opening' : animState;
    if (!isOpen && effectiveAnimState === 'closed') return null;

    const isAnimating = effectiveAnimState === 'opening' || effectiveAnimState === 'closing';

    const ballPos = ballPosition.x >= 0 ? ballPosition : { x: window?.innerWidth - 80 || 0, y: window?.innerHeight - 80 || 0 };
    const initialStyles = {
        left: ballPos.x,
        top: ballPos.y,
        width: 56,
        height: 56,
        borderRadius: '50%',
        opacity: 1,
        transform: 'scale(1)',
    };

    const targetStyles = {
        left: position.x,
        top: position.y,
        width: size.width,
        height: size.height,
        borderRadius: '1.5rem',
        opacity: 1,
        transform: 'scale(1)',
    };

    const currentStyle = (effectiveAnimState === 'closed' || effectiveAnimState === 'opening' || effectiveAnimState === 'closing')
        ? initialStyles
        : targetStyles;

    return (
        <div
            ref={containerRef}
            className="fixed z-50 flex overflow-hidden shadow-2xl border border-white/20"
            style={{
                ...currentStyle,
                background: isAnimating
                    ? 'linear-gradient(135deg, rgba(139, 92, 246, 0.9), rgba(59, 130, 246, 0.9))'
                    : 'linear-gradient(135deg, rgba(255,255,255,0.08), rgba(255,255,255,0.02))',

                backdropFilter: isAnimating ? 'blur(10px)' : 'blur(24px) saturate(180%)',
                WebkitBackdropFilter: isAnimating ? 'blur(10px)' : 'blur(24px) saturate(180%)',

                boxShadow: isAnimating
                    ? '0 0 20px rgba(139, 92, 246, 0.4), 0 0 40px rgba(59, 130, 246, 0.2)'
                    : '0 8px 32px rgba(0, 0, 0, 0.3), inset 0 0 0 1px rgba(255,255,255,0.1)',

                transition: isDragging ? 'none' : 'all 500ms cubic-bezier(0.19, 1, 0.22, 1)',
            }}
        >
            <div
                className={`flex-1 flex w-full h-full transition-opacity ${animState === 'open' ? 'opacity-100 duration-300 delay-100' : 'opacity-0 duration-75 delay-0'
                    } ${animState === 'closing' ? 'pointer-events-none' : ''}`}
            >
                {/* Resize handles */}
                {animState === 'open' && (
                    <>
                        {['nw', 'ne', 'sw', 'se'].map(d => <div key={d} className={`absolute ${d.includes('n') ? 'top-0' : 'bottom-0'} ${d.includes('w') ? 'left-0' : 'right-0'} w-4 h-4 cursor-${d}-resize z-10`} onMouseDown={handleResizeStart(d)} />)}
                        {['n', 's'].map(d => <div key={d} className={`absolute ${d === 'n' ? 'top-0' : 'bottom-0'} left-4 right-4 h-2 cursor-${d}-resize z-10`} onMouseDown={handleResizeStart(d)} />)}
                        {['w', 'e'].map(d => <div key={d} className={`absolute ${d === 'w' ? 'left-0' : 'right-0'} top-4 bottom-4 w-2 cursor-${d}-resize z-10`} onMouseDown={handleResizeStart(d)} />)}
                    </>
                )}

                {/* Sidebar */}
                {showSidebar && (
                    <div className="w-48 bg-white/5 border-r border-white/10 flex flex-col backdrop-blur-sm min-w-[192px]">
                        <div className="p-3 border-b border-white/10 flex items-center justify-between">
                            <span className="text-white/70 text-sm font-medium">{locale === 'zh' ? '对话' : 'Chats'}</span>
                            <button onClick={() => createLocalSession(3)} className="p-1.5 hover:bg-white/10 rounded-lg transition-colors" title={locale === 'zh' ? '新对话' : 'New Chat'}>
                                <Plus size={16} className="text-white/70" />
                            </button>
                        </div>
                        <div className="flex-1 overflow-y-auto p-2 space-y-1">
                            {sessions.map(session => {
                                const style = CATEGORY_STYLES[session.category] || CATEGORY_STYLES[3];
                                return (
                                    <div key={session.id}
                                        onClick={() => setCurrentSessionId(session.id)}
                                        className={`group p-2 rounded-lg cursor-pointer flex items-center gap-2 transition-all ${currentSessionId === session.id ? `${style.bgColor} ring-1 ring-white/20` : 'hover:bg-white/10'}`}>
                                        <span className={style.color}>{style.icon}</span>
                                        <span className="flex-1 text-sm text-white/80 truncate">{session.title}</span>
                                        <button onClick={(e) => { e.stopPropagation(); deleteLocalSession(session.id); }}
                                            disabled={isLoading}
                                            className="opacity-0 group-hover:opacity-100 disabled:hidden p-1 hover:bg-white/20 rounded transition-all"
                                            title={t('common.delete')}>
                                            <Trash2 size={12} className="text-white/50" />
                                        </button>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}

                {/* Main content */}
                <div className="flex-1 flex flex-col bg-gradient-to-b from-transparent to-black/10 min-w-0">
                    {/* Header */}
                    <div className="relative z-10 bg-gradient-to-r from-purple-500/20 to-blue-500/20 p-3 flex items-center justify-between select-none touch-none border-b border-white/10 backdrop-blur-sm"
                        onPointerDown={handleHeaderPointerDown} onPointerMove={handleHeaderPointerMove} onPointerUp={handleHeaderPointerUp}
                        style={{ cursor: isDragging ? 'grabbing' : 'grab' }}>
                        <div className="flex items-center gap-3 overflow-visible flex-1">
                            <button onClick={() => setShowSidebar(!showSidebar)} className="p-1.5 hover:bg-white/10 rounded-lg no-drag">
                                {showSidebar ? <PanelLeftClose size={16} className="text-white/70" /> : <PanelLeft size={16} className="text-white/70" />}
                            </button>
                            <GripVertical className="text-white/40 flex-shrink-0" size={14} />
                            <Sparkles className="text-purple-300 flex-shrink-0" size={18} />
                            <div className="overflow-visible flex-1">
                                <div className="flex items-center gap-2">
                                    <h3 className="text-white font-semibold text-sm truncate">{locale === 'zh' ? 'AI 学习助手' : 'AI Study Assistant'}</h3>
                                    {/* Mode Switcher */}
                                    <div className="relative no-drag">
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                setShowModeSelect(!showModeSelect);
                                            }}
                                            className="flex items-center gap-1 px-2 py-1 text-xs rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 transition-colors"
                                        >
                                            {currentSession && CATEGORY_STYLES[currentSession.category] && (
                                                <>
                                                    <span className={CATEGORY_STYLES[currentSession.category].color}>
                                                        {CATEGORY_STYLES[currentSession.category].icon}
                                                    </span>
                                                    <span className="text-white/80">{CATEGORY_STYLES[currentSession.category].label}</span>
                                                </>
                                            )}
                                            <ChevronDown size={12} className={`text-white/60 transition-transform ${showModeSelect ? 'rotate-180' : ''}`} />
                                        </button>
                                        {showModeSelect && (
                                            <>
                                                <div
                                                    className="fixed inset-0 z-10"
                                                    onClick={() => setShowModeSelect(false)}
                                                />
                                                <div className="absolute top-full left-0 mt-1 backdrop-blur-3xl bg-black/50 border border-white/10 rounded-xl shadow-2xl py-1 z-[9999] min-w-[140px] ring-1 ring-white/10">
                                                    {Object.entries(CATEGORY_STYLES).map(([catNum, style]) => {
                                                        const categoryNum = parseInt(catNum);
                                                        return (
                                                            <button
                                                                key={categoryNum}
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    if (currentSession?.category !== categoryNum) {
                                                                        createLocalSession(
                                                                            categoryNum,
                                                                            categoryNum === 1 ? currentWord || undefined : undefined,
                                                                            categoryNum === 2 ? currentWordGroup || undefined : undefined,
                                                                        );
                                                                    }
                                                                    setShowModeSelect(false);
                                                                }}
                                                                className={`w-full px-3 py-2 text-left hover:bg-white/10 flex items-center gap-2 ${currentSession?.category === categoryNum ? 'bg-white/10' : ''}`}
                                                            >
                                                                <span className={style.color}>{style.icon}</span>
                                                                <span className="text-sm text-white">{style.label}</span>
                                                            </button>
                                                        );
                                                    })}
                                                </div>
                                            </>
                                        )}
                                    </div>
                                </div>
                                <p className="text-white/50 text-xs truncate">{currentSession?.title || (locale === 'zh' ? '新对话' : 'New Chat')}</p>
                            </div>
                        </div>
                        <button onClick={handleClose} className="p-2 hover:bg-white/10 rounded-xl no-drag flex-shrink-0"><Minus size={16} className="text-white/70" /></button>
                    </div>

                    {/* Word Context bar */}
                    {currentWord && currentSession?.category === 1 && (
                        <div className="px-3 py-2 bg-gradient-to-r from-purple-500/15 to-blue-500/15 border-b border-white/10 flex items-center justify-between no-drag backdrop-blur-sm">
                            <div className="flex items-center gap-2 truncate">
                                <BookOpen size={14} className="text-purple-300 flex-shrink-0" />
                                <span className="text-sm text-white/80">{locale === 'zh' ? '单词:' : 'Word:'}</span>
                                <span className="text-sm font-semibold text-white truncate">{currentWord}</span>
                            </div>
                            <button onClick={() => setCurrentWord(null)} className="p-1 hover:bg-white/10 rounded-lg transition-colors flex-shrink-0">
                                <X size={14} className="text-white/50 hover:text-white/80" />
                            </button>
                        </div>
                    )}

                    {/* Model selector */}
                    <div className="px-3 py-2 bg-white/5 border-b border-white/10 no-drag backdrop-blur-sm">
                        <div className="relative">
                            <button onClick={() => setShowModelSelect(!showModelSelect)} className="flex items-center gap-2 text-sm text-white/70 hover:text-white">
                                <span className="text-white/40">{locale === 'zh' ? '模型:' : 'Model:'}</span>
                                <span className="font-medium">{MODELS.find(m => m.id === selectedModel)?.name}</span>
                                <ChevronDown size={14} className={`transition-transform ${showModelSelect ? 'rotate-180' : ''}`} />
                            </button>
                            {showModelSelect && (
                                <div className="absolute top-full left-0 mt-1 backdrop-blur-2xl bg-black/60 border border-white/15 rounded-xl shadow-xl py-1 z-10 min-w-[180px]">
                                    {MODELS.map(model => (
                                        <button key={model.id} onClick={() => { setSelectedModel(model.id); setShowModelSelect(false); }}
                                            className={`w-full px-3 py-2 text-left hover:bg-white/10 ${selectedModel === model.id ? 'bg-white/10' : ''}`}>
                                            <div className="text-sm font-medium text-white">{model.name}</div>
                                            <div className="text-xs text-white/50">{model.description}</div>
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Messages */}
                    <div className="flex-1 overflow-y-auto p-4 space-y-4 scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent">
                        {messages.map((msg, idx) => (
                            <div key={idx} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                                {msg.kind === 'paywall' ? (
                                    <div className="max-w-[85%] p-4 rounded-2xl border border-amber-300/30 bg-gradient-to-br from-amber-500/15 to-purple-500/10 backdrop-blur-sm">
                                        <div className="flex items-center gap-2 text-amber-200 text-sm font-medium">
                                            <Crown size={14} />
                                            <span>{t('paywall.quotaTitle')}</span>
                                        </div>
                                        <p className="mt-1.5 text-xs leading-relaxed text-white/65">
                                            {t('paywall.quotaBody', {
                                                used: msg.quota?.used ?? '–',
                                                limit: msg.quota?.limit ?? '–',
                                            })}
                                        </p>
                                        <Link
                                            href="/pricing"
                                            className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-white px-4 py-1.5 text-xs font-semibold text-black transition-all hover:bg-white/90 active:scale-95"
                                        >
                                            <Sparkles size={12} />
                                            {t('paywall.upgrade')}
                                        </Link>
                                    </div>
                                ) : (
                                    <div className={`max-w-[85%] p-3 rounded-2xl backdrop-blur-sm ${msg.role === 'user' ? 'bg-purple-500/30 text-white' : 'bg-white/10 text-white/90'}`}>
                                        <div className="prose prose-invert prose-sm max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
                                            <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                                        </div>
                                    </div>
                                )}
                            </div>
                        ))}
                        {streamingContent && (
                            <div className="flex justify-start">
                                <div className="max-w-[85%] p-3 rounded-2xl bg-white/10 text-white/90 backdrop-blur-sm">
                                    <div className="prose prose-invert prose-sm max-w-none"><ReactMarkdown remarkPlugins={[remarkGfm]}>{streamingContent}</ReactMarkdown></div>
                                </div>
                            </div>
                        )}
                        {((isLoading && !streamingContent) || historyLoading) && (
                            <div className="flex justify-start"><div className="p-3 rounded-2xl bg-white/10 backdrop-blur-sm"><Loader2 className="w-5 h-5 text-white/50 animate-spin" /></div></div>
                        )}
                        <div ref={messagesEndRef} />
                    </div>

                    {/* Input */}
                    <div className="p-4 border-t border-white/10 bg-white/5 backdrop-blur-sm">
                        <div className="flex gap-2">
                            <textarea
                                ref={inputRef}
                                value={input}
                                onChange={(e) => setInput(e.target.value)}
                                onKeyDown={handleKeyDown}
                                placeholder={locale === 'zh' ? '输入问题或指令...' : 'Type a message or instruction...'}
                                rows={1}
                                className="flex-1 bg-white/10 text-white placeholder-white/40 rounded-xl px-4 py-3 resize-none outline-none focus:ring-2 ring-purple-500/50 backdrop-blur-sm"
                            />
                            {isLoading ? (
                                <button onClick={stopGeneration} className="px-4 py-2 bg-red-500/30 hover:bg-red-500/40 rounded-xl transition-colors backdrop-blur-sm"><Square size={18} className="text-white" /></button>
                            ) : (
                                <button onClick={sendMessage} disabled={!input.trim()} className="px-4 py-2 bg-purple-500/30 hover:bg-purple-500/40 rounded-xl transition-colors disabled:opacity-50 backdrop-blur-sm"><Send size={18} className="text-white" /></button>
                            )}
                        </div>
                    </div>
                </div>

            </div>
        </div>
    );
}
