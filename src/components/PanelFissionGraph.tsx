'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import type { ForceGraphMethods, ForceGraphProps, LinkObject, NodeObject } from 'react-force-graph-2d';
import { forceCollide, forceRadial, forceX, forceY } from 'd3-force';
import { Maximize, Minus, Plus, RotateCcw } from 'lucide-react';
import { useSettings } from '@/context/SettingsContext';
import { useTheme, type Theme } from '@/context/ThemeContext';
import WordTooltip from './WordTooltip';
import {
    GROUP_COLORS, RELATION_GROUPS, groupOf,
    type Familiarity, type GraphData, type GraphNode, type RelationGroup,
} from '@/lib/graph-shared';

function GraphLoadingFallback() {
    const t = useTranslations('graph');
    return <div className="flex h-full items-center justify-center text-sm text-neutral-500">{t('loadingGraph')}</div>;
}

// next/dynamic drops the component's generics; re-attach them so callbacks get typed nodes.
type AtlasGraphProps = ForceGraphProps<NodeObject<AtlasNode>, LinkObject<AtlasNode, AtlasLink>> & {
    ref?: React.MutableRefObject<ForceGraphMethods<NodeObject<AtlasNode>, LinkObject<AtlasNode, AtlasLink>> | undefined>;
};
const ForceGraph2D = dynamic(() => import('react-force-graph-2d'), {
    ssr: false,
    loading: () => <GraphLoadingFallback />,
}) as unknown as React.ComponentType<AtlasGraphProps>;

interface PanelFissionGraphProps {
    word: string | null;
    onNodeClick?: (word: string) => void;
}

// ---------------------------------------------------------------------------
// Layout model. The API returns an ego network: the centre word, its direct neighbours (L1) and
// their neighbours (L2). Each L1 word belongs to one relation group; groups sit in their own
// sector around the centre, the word family hugs the centre inside a dashed bubble.
// ---------------------------------------------------------------------------

/** Neighbours shown per group before "show all". */
const GROUP_CAP = 10;
/** Second-degree words shown per neighbour. */
const L2_PER_PARENT = 3;
/** When a word is linked to the centre in several ways, the first group in this list wins. */
const GROUP_PRIORITY: RelationGroup[] = ['family', 'antonym', 'synonym', 'near_synonym', 'spelling_similar'];

const RADIUS = { center: 15, l1: 8.5, l2: 4 };

interface AtlasNode extends GraphNode {
    group: RelationGroup | null;
    parentId?: string;
    /** Order inside its group (L1) or under its parent (L2). */
    rank: number;
    ax: number;
    ay: number;
    /** Distance from the centre the layout keeps this word at. */
    ring?: number;
    x?: number;
    y?: number;
    fx?: number;
    fy?: number;
}

interface AtlasLink {
    source: string | AtlasNode;
    target: string | AtlasNode;
    group: RelationGroup;
    level: 1 | 2;
    pending: boolean;
}

interface Atlas {
    centerId: string;
    nodes: AtlasNode[];
    links: AtlasLink[];
    totals: Record<RelationGroup, number>;
}

const endpointId = (end: string | { id: string }) => (typeof end === 'object' ? end.id : end);

function buildAtlas(data: GraphData): Atlas | null {
    const center = data.nodes.find((n) => n.level === 0);
    if (!center) return null;

    const l1Group = new Map<string, RelationGroup>();
    const l2Parent = new Map<string, string>();
    for (const link of data.links) {
        const s = endpointId(link.source as string | { id: string });
        const t = endpointId(link.target as string | { id: string });
        if (s === center.id && t !== center.id) {
            const g = groupOf(link.type);
            const prev = l1Group.get(t);
            if (!prev || GROUP_PRIORITY.indexOf(g) < GROUP_PRIORITY.indexOf(prev)) l1Group.set(t, g);
        } else if (t !== center.id && !l2Parent.has(t)) {
            l2Parent.set(t, s);
        }
    }

    const byId = new Map(data.nodes.map((n) => [n.id, n]));
    const totals = Object.fromEntries(RELATION_GROUPS.map((g) => [g, 0])) as Record<RelationGroup, number>;
    const nodes: AtlasNode[] = [{ ...center, group: null, rank: 0, ax: 0, ay: 0, fx: 0, fy: 0 }];

    // Entries that exist in the dictionary first, then alphabetical.
    const l1 = [...l1Group.entries()]
        .filter(([id]) => byId.has(id))
        .sort(([a], [b]) => Number(!!byId.get(a)!.placeholder) - Number(!!byId.get(b)!.placeholder) || a.localeCompare(b));
    for (const [id, group] of l1) {
        nodes.push({ ...byId.get(id)!, level: 1, group, rank: totals[group]++, ax: 0, ay: 0 });
    }

    const perParent = new Map<string, number>();
    for (const [id, parentId] of l2Parent) {
        const node = byId.get(id);
        if (!node || l1Group.has(id) || !l1Group.has(parentId)) continue;
        const rank = perParent.get(parentId) ?? 0;
        perParent.set(parentId, rank + 1);
        nodes.push({ ...node, level: 2, group: l1Group.get(parentId)!, parentId, rank, ax: 0, ay: 0 });
    }

    const known = new Set(nodes.map((n) => n.id));
    const links: AtlasLink[] = [];
    const seen = new Set<string>();
    for (const link of data.links) {
        const s = endpointId(link.source as string | { id: string });
        const t = endpointId(link.target as string | { id: string });
        if (!known.has(s) || !known.has(t)) continue;
        const level = s === center.id ? 1 : 2;
        const key = `${s}|${t}`;
        if (seen.has(key)) continue;
        seen.add(key);
        links.push({
            source: s,
            target: t,
            group: level === 1 ? l1Group.get(t)! : groupOf(link.type),
            level,
            pending: link.status === 'pending',
        });
    }
    return { centerId: center.id, nodes, links, totals };
}

interface Visibility {
    hidden: Set<RelationGroup>;
    expanded: Set<RelationGroup>;
    secondDegree: boolean;
}

/** Nodes and links on screen, with layout anchors assigned for the visible sectors. */
function visibleGraph(atlas: Atlas, vis: Visibility) {
    const showL1 = (n: AtlasNode) => !vis.hidden.has(n.group!) && (vis.expanded.has(n.group!) || n.rank < GROUP_CAP);
    const l1 = atlas.nodes.filter((n) => n.level === 1 && showL1(n));
    const l1Ids = new Set(l1.map((n) => n.id));
    const l2 = vis.secondDegree
        ? atlas.nodes.filter((n) => n.level === 2 && n.parentId && l1Ids.has(n.parentId) && n.rank < L2_PER_PARENT)
        : [];

    const family = l1.filter((n) => n.group === 'family');
    const familyRadius = family.length ? Math.max(58, 7 * family.length + 34) : 0;
    family.forEach((n, i) => {
        const a = (i / family.length) * Math.PI * 2 - Math.PI / 2;
        n.ax = Math.cos(a) * familyRadius;
        n.ay = Math.sin(a) * familyRadius;
    });

    const sectors = RELATION_GROUPS.filter((g) => g !== 'family' && l1.some((n) => n.group === g));
    const sectorRadius = familyRadius + 170;
    const anchors = new Map<RelationGroup, { x: number; y: number }>();
    sectors.forEach((g, i) => {
        const a = (i / sectors.length) * Math.PI * 2 - Math.PI / 3;
        anchors.set(g, { x: Math.cos(a) * sectorRadius, y: Math.sin(a) * sectorRadius });
    });
    for (const n of l1) {
        if (n.group === 'family') continue;
        const anchor = anchors.get(n.group!)!;
        n.ax = anchor.x;
        n.ay = anchor.y;
    }
    const l1ById = new Map(l1.map((n) => [n.id, n]));
    for (const n of l2) {
        const parent = l1ById.get(n.parentId!)!;
        n.ax = parent.ax * 1.5;
        n.ay = parent.ay * 1.5;
    }

    for (const n of [...l1, ...l2]) {
        n.ring = n.level === 2 ? sectorRadius * 1.5 : n.group === 'family' ? familyRadius : sectorRadius;
    }

    const nodes = [atlas.nodes[0], ...l1, ...l2];
    const ids = new Set(nodes.map((n) => n.id));
    const links = atlas.links.filter((l) => {
        const s = endpointId(l.source), t = endpointId(l.target);
        if (!ids.has(s) || !ids.has(t)) return false;
        // Family membership is shown by the bubble, not by edges.
        return !(l.level === 1 && l.group === 'family');
    });
    return { nodes, links, family, sectors, familyRadius, sectorRadius, anchors };
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

const PALETTE: Record<Theme, {
    bg: string; ink: string; muted: string; halo: string; centerRing: string; edgeAlpha: number;
    bubbleFill: string; fills: Record<Familiarity | 'new', string>;
}> = {
    dark: {
        bg: '#05070d', ink: '#eaf2ff', muted: '#8ca3c4', halo: 'rgba(5,7,13,0.92)', centerRing: '#38bdf8',
        edgeAlpha: 0.5, bubbleFill: 'rgba(167,139,250,0.06)',
        fills: { new: '#0e1525', seen: '#173252', weak: '#5a1f2b', learning: '#4a3711', mastered: '#124430' },
    },
    light: {
        bg: '#f1ede4', ink: '#20302c', muted: '#61706b', halo: 'rgba(241,237,228,0.95)', centerRing: '#1b6c53',
        edgeAlpha: 0.55, bubbleFill: 'rgba(139,92,246,0.05)',
        fills: { new: '#fffdf8', seen: '#d7e9f5', weak: '#f5d7d4', learning: '#fbe7bf', mastered: '#d8eedb' },
    },
};

const FAMILIARITY_ORDER: Array<Familiarity | 'new'> = ['new', 'seen', 'weak', 'learning', 'mastered'];

/** "vt. 放弃, 抛弃, 遗弃" -> "放弃, 抛弃" */
function shortGloss(translation?: string): string {
    if (!translation) return '';
    const text = translation.replace(/^\s*([a-z]+\.\s*)+/i, '').split(/[;；]/)[0];
    const parts = text.split(/[,，]/).map((s) => s.trim()).filter(Boolean).slice(0, 2).join(', ');
    return parts.length > 14 ? `${parts.slice(0, 13)}…` : parts;
}

export default function PanelFissionGraph({ word, onNodeClick }: PanelFissionGraphProps) {
    const t = useTranslations('graph');
    const { showHoverTooltip, showGraphTooltip } = useSettings();
    const { theme } = useTheme();
    const palette = PALETTE[theme];

    const [data, setData] = useState<GraphData | null>(null);
    const [loading, setLoading] = useState(false);
    const [familiarity, setFamiliarity] = useState<Record<string, Familiarity>>({});
    const [hidden, setHidden] = useState<Set<RelationGroup>>(new Set());
    const [expanded, setExpanded] = useState<Set<RelationGroup>>(new Set());
    const [secondDegree, setSecondDegree] = useState(false);
    const [hovered, setHovered] = useState<AtlasNode | null>(null);
    const [size, setSize] = useState({ width: 0, height: 0 });
    const [zoomK, setZoomK] = useState(1);

    const containerRef = useRef<HTMLDivElement>(null);
    const fgRef = useRef<ForceGraphMethods<NodeObject<AtlasNode>, LinkObject<AtlasNode, AtlasLink>> | undefined>(undefined);
    const tooltipRef = useRef<HTMLDivElement>(null);
    const pillRefs = useRef(new Map<RelationGroup, HTMLDivElement>());
    const fittedRef = useRef(false);
    const zoomFrame = useRef<number | null>(null);

    // ---- data -------------------------------------------------------------
    useEffect(() => {
        if (!word) { setData(null); return; }
        const controller = new AbortController();
        setLoading(true);
        setExpanded(new Set());
        fittedRef.current = false;
        fetch(`/api/fission?word=${encodeURIComponent(word)}`, { signal: controller.signal })
            .then((res) => res.json() as Promise<GraphData>)
            .then((graph) => setData(graph))
            .catch((err) => { if (err?.name !== 'AbortError') setData({ nodes: [], links: [] }); })
            .finally(() => { if (!controller.signal.aborted) setLoading(false); });
        return () => controller.abort();
    }, [word]);

    useEffect(() => {
        if (!data?.nodes.length) { setFamiliarity({}); return; }
        const controller = new AbortController();
        fetch('/api/user/word-states', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ words: data.nodes.map((n) => n.id) }),
            signal: controller.signal,
        })
            .then((res) => (res.ok ? res.json() : { states: {} }))
            .then((body: { states?: Record<string, Familiarity> }) => setFamiliarity(body.states ?? {}))
            .catch(() => undefined);
        return () => controller.abort();
    }, [data]);

    const atlas = useMemo(() => (data ? buildAtlas(data) : null), [data]);
    const view = useMemo(
        () => (atlas ? visibleGraph(atlas, { hidden, expanded, secondDegree }) : null),
        [atlas, hidden, expanded, secondDegree],
    );
    const graphData = useMemo(() => (view ? { nodes: view.nodes, links: view.links } : { nodes: [], links: [] }), [view]);

    const neighbours = useMemo(() => {
        const map = new Map<string, Set<string>>();
        for (const l of view?.links ?? []) {
            const s = endpointId(l.source), tId = endpointId(l.target);
            if (!map.has(s)) map.set(s, new Set());
            if (!map.has(tId)) map.set(tId, new Set());
            map.get(s)!.add(tId);
            map.get(tId)!.add(s);
        }
        return map;
    }, [view]);

    // ---- size / keyboard -----------------------------------------------------
    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const observer = new ResizeObserver(([entry]) => {
            const { width, height } = entry.contentRect;
            setSize({ width: Math.round(width), height: Math.round(height) });
        });
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement | null;
            if (e.repeat || target?.closest('input, textarea, [contenteditable="true"]')) return;
            if (e.key.toLowerCase() === 'h') setSecondDegree((v) => !v);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    // ---- forces --------------------------------------------------------------
    // The graph instance appears only after its chunk loads, so this also runs from onEngineTick;
    // appliedFor makes it a no-op once the current view is configured.
    const appliedFor = useRef<object | null>(null);
    const applyForces = useCallback(() => {
        const fg = fgRef.current;
        if (!fg || !view || appliedFor.current === view) return;
        appliedFor.current = view;
        fittedRef.current = false;
        fg.d3Force('center', null);
        fg.d3Force('charge')?.strength(-80).distanceMax(260);
        fg.d3Force('link')
            ?.distance((l: AtlasLink) => (l.level === 1 ? Math.hypot((l.target as AtlasNode).ax, (l.target as AtlasNode).ay) : 42))
            .strength((l: AtlasLink) => (l.level === 1 ? 0.02 : 0.35));
        fg.d3Force('x', forceX<AtlasNode>((n) => n.ax).strength((n) => (n.level === 0 ? 0 : n.level === 1 ? 0.12 : 0.06)));
        fg.d3Force('y', forceY<AtlasNode>((n) => n.ay).strength((n) => (n.level === 0 ? 0 : n.level === 1 ? 0.12 : 0.06)));
        fg.d3Force('ring', forceRadial<AtlasNode>((n) => n.ring ?? 0, 0, 0).strength((n) => (n.level === 0 ? 0 : 0.18)));
        fg.d3Force('collide', forceCollide<AtlasNode>((n) => {
            if (n.level === 0) return RADIUS.center + 14;
            if (n.level === 2) return RADIUS.l2 + 10;
            return RADIUS.l1 + Math.min(34, n.name.length * 3.2) + 6;
        }).strength(0.9).iterations(3));
        fg.d3ReheatSimulation();
    }, [view]);
    useEffect(() => { applyForces(); }, [applyForces]);

    const fit = useCallback((ms = 500) => fgRef.current?.zoomToFit(ms, 64), []);

    // Panels are resizable: keep the graph framed when the available space changes.
    useEffect(() => {
        if (!fittedRef.current) return;
        const timer = window.setTimeout(() => fit(250), 150);
        return () => window.clearTimeout(timer);
    }, [size, fit]);

    const relayout = useCallback(() => {
        for (const n of view?.nodes ?? []) {
            if (n.level === 0) continue;
            n.fx = undefined;
            n.fy = undefined;
            n.x = n.ax + (Math.random() - 0.5) * 20;
            n.y = n.ay + (Math.random() - 0.5) * 20;
        }
        fittedRef.current = false;
        fgRef.current?.d3ReheatSimulation();
    }, [view]);

    const setZoom = (k: number) => fgRef.current?.zoom(Math.min(4, Math.max(0.25, k)), 250);

    // ---- per-frame overlays (group pills, tooltip) ---------------------------------
    const placeOverlays = useCallback(() => {
        const fg = fgRef.current;
        if (!fg || !view) return;
        for (const [group, el] of pillRefs.current) {
            const members = view.nodes.filter((n) => n.level === 1 && n.group === group && n.x !== undefined);
            if (!members.length) { el.style.visibility = 'hidden'; continue; }
            let x: number, y: number;
            if (group === 'family') {
                const r = Math.max(...members.map((n) => Math.hypot(n.x!, n.y!))) + RADIUS.l1 + 16;
                x = 0; y = -r;
            } else {
                const anchor = view.anchors.get(group);
                if (!anchor) { el.style.visibility = 'hidden'; continue; }
                const d = Math.hypot(anchor.x, anchor.y) || 1;
                const ux = anchor.x / d, uy = anchor.y / d;
                const reach = Math.max(...members.map((n) => n.x! * ux + n.y! * uy));
                x = ux * (reach + 34);
                y = uy * (reach + 34);
            }
            const p = fg.graph2ScreenCoords(x, y);
            const px = Math.min(Math.max(p.x, 70), size.width - 70);
            const py = Math.min(Math.max(p.y, 14), size.height - 50);
            el.style.visibility = 'visible';
            el.style.transform = `translate(${px}px, ${py}px) translate(-50%, -50%)`;
        }
        if (hovered && tooltipRef.current && hovered.x !== undefined) {
            const p = fg.graph2ScreenCoords(hovered.x, hovered.y ?? 0);
            tooltipRef.current.style.transform = `translate(${p.x}px, ${p.y - 18}px) translate(-50%, -100%)`;
        }
    }, [view, hovered, size]);

    // ---- canvas painters -------------------------------------------------------
    const drawFamilyBubble = useCallback((ctx: CanvasRenderingContext2D, scale: number) => {
        if (!view?.family.length) return;
        const r = Math.max(...view.family.map((n) => Math.hypot(n.x ?? n.ax, n.y ?? n.ay))) + RADIUS.l1 + 14;
        ctx.save();
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.fillStyle = palette.bubbleFill;
        ctx.fill();
        ctx.setLineDash([6 / scale, 5 / scale]);
        ctx.lineWidth = 1.2 / scale;
        ctx.strokeStyle = GROUP_COLORS.family;
        ctx.globalAlpha = 0.65;
        ctx.stroke();
        ctx.restore();
    }, [view, palette]);

    const paintLink = useCallback((link: AtlasLink, ctx: CanvasRenderingContext2D, scale: number) => {
        const s = link.source as AtlasNode, e = link.target as AtlasNode;
        if (s.x === undefined || e.x === undefined) return;
        const lit = hovered && (s.id === hovered.id || e.id === hovered.id);
        const dim = hovered && !lit;
        ctx.save();
        ctx.strokeStyle = GROUP_COLORS[link.group];
        ctx.globalAlpha = lit ? 0.95 : dim ? 0.12 : palette.edgeAlpha * (link.level === 2 ? 0.55 : 1);
        ctx.lineWidth = (lit ? 2 : link.level === 2 ? 0.8 : 1.3) / scale;
        if (link.pending) ctx.setLineDash([5 / scale, 4 / scale]);
        ctx.beginPath();
        ctx.moveTo(s.x, s.y!);
        ctx.lineTo(e.x, e.y!);
        ctx.stroke();
        ctx.restore();
    }, [hovered, palette]);

    const paintNode = useCallback((node: AtlasNode, ctx: CanvasRenderingContext2D, scale: number) => {
        const x = node.x ?? 0, y = node.y ?? 0;
        const isHovered = hovered?.id === node.id;
        const dim = hovered && !isHovered && !neighbours.get(hovered.id)?.has(node.id) && node.level !== 0;
        const fill = palette.fills[familiarity[node.id] ?? 'new'];
        ctx.save();
        if (dim) ctx.globalAlpha = 0.35;

        if (node.level === 0) {
            ctx.beginPath();
            ctx.arc(x, y, RADIUS.center + 5, 0, Math.PI * 2);
            ctx.strokeStyle = palette.centerRing;
            ctx.lineWidth = 2.5 / scale;
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(x, y, RADIUS.center, 0, Math.PI * 2);
            ctx.fillStyle = fill;
            ctx.fill();
            ctx.lineWidth = 1.5 / scale;
            ctx.stroke();
        } else if (node.level === 1) {
            const color = GROUP_COLORS[node.group!];
            ctx.beginPath();
            ctx.arc(x, y, RADIUS.l1 * (isHovered ? 1.25 : 1), 0, Math.PI * 2);
            if (node.placeholder) {
                ctx.setLineDash([3 / scale, 3 / scale]);
                ctx.strokeStyle = palette.muted;
            } else {
                ctx.fillStyle = fill;
                ctx.fill();
                ctx.strokeStyle = color;
            }
            ctx.lineWidth = 2 / scale;
            ctx.stroke();
        } else {
            ctx.beginPath();
            ctx.arc(x, y, RADIUS.l2 * (isHovered ? 1.4 : 1), 0, Math.PI * 2);
            ctx.fillStyle = GROUP_COLORS[node.group!];
            ctx.globalAlpha *= node.placeholder ? 0.35 : 0.7;
            ctx.fill();
        }
        ctx.restore();
    }, [hovered, neighbours, familiarity, palette]);

    const paintLabels = useCallback((ctx: CanvasRenderingContext2D, scale: number) => {
        if (!view) return;
        const showGloss = scale >= 1.15;
        ctx.save();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.lineJoin = 'round';
        for (const node of view.nodes) {
            if (node.x === undefined) continue;
            const isHovered = hovered?.id === node.id;
            const near = hovered && (isHovered || neighbours.get(hovered.id)?.has(node.id));
            if (node.level === 2 && scale < 1.4 && !near) continue;
            const r = node.level === 0 ? RADIUS.center + 7 : node.level === 1 ? RADIUS.l1 : RADIUS.l2;
            const px = node.level === 0 ? 14 : node.level === 1 ? 12 : 10;
            const dim = hovered && !near && node.level !== 0;
            ctx.globalAlpha = dim ? 0.35 : 1;
            ctx.font = `${node.level === 0 ? '600 ' : ''}${px / scale}px Geist, "Noto Sans SC", system-ui, sans-serif`;
            const y = node.y! + r + 3 / scale;
            ctx.strokeStyle = palette.halo;
            ctx.lineWidth = 3.5 / scale;
            ctx.strokeText(node.name, node.x, y);
            ctx.fillStyle = node.placeholder ? palette.muted : palette.ink;
            ctx.fillText(node.name, node.x, y);
            if (node.level < 2 && (showGloss || node.level === 0)) {
                const gloss = shortGloss(node.translation);
                if (gloss) {
                    ctx.font = `${10 / scale}px "Noto Sans SC", system-ui, sans-serif`;
                    const gy = y + (px + 2) / scale;
                    ctx.strokeText(gloss, node.x, gy);
                    ctx.fillStyle = palette.muted;
                    ctx.fillText(gloss, node.x, gy);
                }
            }
        }
        ctx.restore();
    }, [view, hovered, neighbours, palette]);

    // ---- render ----------------------------------------------------------------
    if (!word) {
        return <div className="flex h-full items-center justify-center text-sm tracking-wide text-neutral-500">{t('selectWord')}</div>;
    }

    const totals = atlas?.totals;
    const totalWords = atlas ? atlas.nodes.length - 1 : 0;
    const shownWords = view ? view.nodes.length - 1 : 0;
    const groupsPresent = RELATION_GROUPS.filter((g) => (totals?.[g] ?? 0) > 0);
    const groupLabel = (g: RelationGroup) => t(`atlas.groups.${g}`);

    return (
        <div className="absolute inset-0 flex flex-col overflow-hidden" style={{ background: palette.bg }}>
            {/* Toolbar */}
            <div className="z-20 flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-neutral-800 bg-neutral-950/85 px-3 py-2 backdrop-blur-md">
                <div className="min-w-0">
                    <div className="text-[9px] font-bold uppercase tracking-[0.24em] text-emerald-400">{t('atlas.eyebrow')}</div>
                    <div className="flex items-baseline gap-2">
                        <span className="truncate text-lg leading-tight text-white" style={{ fontFamily: "'Instrument Serif', serif" }}>{word}</span>
                        {atlas && <span className="whitespace-nowrap text-[11px] text-neutral-500">{t('atlas.stats', { shown: shownWords, total: totalWords })}</span>}
                    </div>
                </div>
                <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
                    {groupsPresent.map((g) => {
                        const on = !hidden.has(g);
                        return (
                            <button
                                key={g}
                                type="button"
                                aria-pressed={on}
                                onClick={() => setHidden((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(g)) next.delete(g); else next.add(g);
                                    return next;
                                })}
                                className={`inline-flex items-center gap-1.5 rounded border px-2 py-1 text-[11px] leading-none transition-colors hover:bg-neutral-800 ${on ? 'font-semibold text-neutral-100' : 'border-neutral-800 text-neutral-500'}`}
                                style={on ? { borderColor: GROUP_COLORS[g] } : undefined}
                            >
                                <span className="h-2 w-2 rounded-full" style={{ background: GROUP_COLORS[g], opacity: on ? 1 : 0.4 }} />
                                {groupLabel(g)}
                                <span className="font-normal text-neutral-500">{totals![g]}</span>
                            </button>
                        );
                    })}
                    <button
                        type="button"
                        aria-pressed={secondDegree}
                        title={t('atlas.secondDegreeHint')}
                        onClick={() => setSecondDegree((v) => !v)}
                        className={`rounded border px-2 py-1 text-[11px] leading-none transition-colors ${secondDegree ? 'border-neutral-600 bg-neutral-800 text-neutral-100' : 'border-neutral-800 text-neutral-500 hover:bg-neutral-800'}`}
                    >
                        {t('atlas.secondDegree')}
                    </button>
                </div>
            </div>

            <div ref={containerRef} className="relative min-h-0 flex-1">
                {/* Graph */}
                {size.width > 0 && view && view.nodes.length > 1 && (
                    <ForceGraph2D
                        ref={fgRef}
                        width={size.width}
                        height={size.height}
                        graphData={graphData}
                        backgroundColor={palette.bg}
                        nodeId="id"
                        nodeLabel={() => ''}
                        nodeRelSize={1}
                        nodeVal={(n: AtlasNode) => (n.level === 0 ? RADIUS.center ** 2 : n.level === 1 ? RADIUS.l1 ** 2 : RADIUS.l2 ** 2)}
                        nodeCanvasObject={paintNode}
                        nodePointerAreaPaint={(n: AtlasNode, color: string, ctx: CanvasRenderingContext2D) => {
                            ctx.fillStyle = color;
                            ctx.beginPath();
                            ctx.arc(n.x ?? 0, n.y ?? 0, (n.level === 0 ? RADIUS.center : n.level === 1 ? RADIUS.l1 : RADIUS.l2) + 5, 0, Math.PI * 2);
                            ctx.fill();
                        }}
                        linkCanvasObject={paintLink}
                        onRenderFramePre={drawFamilyBubble}
                        onRenderFramePost={(ctx: CanvasRenderingContext2D, scale: number) => { paintLabels(ctx, scale); placeOverlays(); }}
                        onEngineTick={applyForces}
                        d3AlphaDecay={0.035}
                        d3VelocityDecay={0.38}
                        warmupTicks={40}
                        cooldownTicks={160}
                        onEngineStop={() => { if (!fittedRef.current) { fittedRef.current = true; fit(400); } }}
                        onZoom={({ k }: { k: number }) => {
                            if (zoomFrame.current !== null) return;
                            zoomFrame.current = requestAnimationFrame(() => { zoomFrame.current = null; setZoomK(k); });
                        }}
                        onNodeHover={(n: AtlasNode | null) => {
                            setHovered(n);
                            if (containerRef.current) containerRef.current.style.cursor = n ? 'pointer' : 'default';
                        }}
                        onNodeClick={(n: AtlasNode) => { if (n.level !== 0) onNodeClick?.(n.id); }}
                        onNodeDragEnd={(n: AtlasNode) => { if (n.level !== 0) { n.fx = n.x; n.fy = n.y; } }}
                    />
                )}

                {/* Group pills ("Synonyms 10/13 · show all") */}
                {view && groupsPresent.filter((g) => !hidden.has(g)).map((g) => {
                    const total = totals![g];
                    const shown = Math.min(total, expanded.has(g) ? total : GROUP_CAP);
                    const canToggle = total > GROUP_CAP;
                    const label = expanded.has(g) ? t('atlas.showFewer', { group: groupLabel(g) }) : t('atlas.showAll', { total, group: groupLabel(g) });
                    return (
                        <div
                            key={g}
                            ref={(el) => { if (el) pillRefs.current.set(g, el); else pillRefs.current.delete(g); }}
                            className="pointer-events-auto absolute left-0 top-0 z-10"
                            style={{ visibility: 'hidden' }}
                        >
                            <button
                                type="button"
                                disabled={!canToggle}
                                title={canToggle ? label : undefined}
                                aria-label={canToggle ? label : undefined}
                                onClick={() => setExpanded((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(g)) next.delete(g); else next.add(g);
                                    return next;
                                })}
                                className="whitespace-nowrap rounded-full border bg-neutral-950/90 px-2.5 py-0.5 text-[11px] font-semibold shadow-sm disabled:cursor-default enabled:hover:bg-neutral-900"
                                style={{ borderColor: GROUP_COLORS[g], color: GROUP_COLORS[g] }}
                            >
                                {groupLabel(g)} {g === 'family' ? `· ${shown}` : `${shown}/${total}`}
                                {canToggle && <span className="ml-1 font-normal">{expanded.has(g) ? '−' : '+'}</span>}
                            </button>
                        </div>
                    );
                })}

                {/* States */}
                {loading && <div className="absolute inset-0 z-10 flex items-center justify-center text-sm text-neutral-500">{t('loadingGraph')}</div>}
                {!loading && view && view.nodes.length <= 1 && (
                    <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-neutral-500">{t('atlas.empty')}</div>
                )}

                {/* Familiarity legend (needs room next to the zoom bar) */}
                {size.width >= 640 && (
                <div className="absolute bottom-3 left-3 z-10 flex items-center gap-2.5 rounded-md border border-neutral-800 bg-neutral-950/85 px-2.5 py-1.5 text-[10px] text-neutral-400 backdrop-blur">
                    <span className="font-semibold text-neutral-300">{t('atlas.legend.title')}</span>
                    {FAMILIARITY_ORDER.map((f) => (
                        <span key={f} className="inline-flex items-center gap-1">
                            <span className="h-2.5 w-2.5 rounded-full border border-neutral-600" style={{ background: palette.fills[f] }} />
                            {t(`atlas.legend.${f}`)}
                        </span>
                    ))}
                    <span className="inline-flex items-center gap-1">
                        <span className="h-2.5 w-2.5 rounded-full border border-dashed border-neutral-500" />
                        {t('atlas.legend.unbuilt')}
                    </span>
                </div>
                )}

                {/* Zoom bar */}
                <div className="absolute bottom-3 right-3 z-10 flex items-center gap-1 rounded-md border border-neutral-800 bg-neutral-950/85 px-1.5 py-1 text-neutral-400 backdrop-blur">
                    <button type="button" onClick={() => setZoom(zoomK / 1.25)} title={t('zoomOut')} aria-label={t('zoomOut')} className="rounded p-1 hover:bg-neutral-800 hover:text-white"><Minus size={14} /></button>
                    <input
                        type="range"
                        min={25}
                        max={400}
                        step={5}
                        value={Math.round(zoomK * 100)}
                        onChange={(e) => setZoom(Number(e.target.value) / 100)}
                        aria-label={t('atlas.zoom')}
                        className="hidden h-1 w-20 cursor-pointer accent-emerald-500 md:block"
                    />
                    <button type="button" onClick={() => setZoom(zoomK * 1.25)} title={t('zoomIn')} aria-label={t('zoomIn')} className="rounded p-1 hover:bg-neutral-800 hover:text-white"><Plus size={14} /></button>
                    <span className="w-9 text-center text-[10px] tabular-nums">{Math.round(zoomK * 100)}%</span>
                    <button type="button" onClick={() => fit()} title={t('atlas.fit')} aria-label={t('atlas.fit')} className="rounded p-1 hover:bg-neutral-800 hover:text-white"><Maximize size={14} /></button>
                    <button type="button" onClick={relayout} title={t('atlas.relayout')} aria-label={t('atlas.relayout')} className="rounded p-1 hover:bg-neutral-800 hover:text-white"><RotateCcw size={14} /></button>
                </div>

                {/* Hover tooltip */}
                {showHoverTooltip && showGraphTooltip && hovered && (
                    <div ref={tooltipRef} className="pointer-events-none absolute left-0 top-0 z-30">
                        <WordTooltip word={hovered.name} phonetic={hovered.phonetic} translation={hovered.translation} />
                    </div>
                )}
            </div>
        </div>
    );
}
