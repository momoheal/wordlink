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

const RADIUS = { center: 17, l1: 10, l2: 4.5 };

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
    const familyRadius = family.length ? Math.max(72, 8 * family.length + 44) : 0;
    family.forEach((n, i) => {
        const a = (i / family.length) * Math.PI * 2 - Math.PI / 2;
        n.ax = Math.cos(a) * familyRadius;
        n.ay = Math.sin(a) * familyRadius;
    });

    // Each relation group owns a sector; its words fan out on an arc (two staggered rows) so a
    // big group spreads sideways instead of piling up toward the centre.
    const sectors = RELATION_GROUPS.filter((g) => g !== 'family' && l1.some((n) => n.group === g));
    const largest = Math.max(1, ...sectors.map((g) => l1.filter((n) => n.group === g).length));
    const sectorRadius = familyRadius + 150 + 4 * largest;
    const span = sectors.length ? (Math.PI * 2) / sectors.length : 0;
    const anchors = new Map<RelationGroup, { x: number; y: number }>();
    sectors.forEach((g, i) => {
        const center = i * span - Math.PI / 3;
        anchors.set(g, { x: Math.cos(center) * sectorRadius, y: Math.sin(center) * sectorRadius });
        const members = l1.filter((n) => n.group === g);
        const step = Math.min(span * 0.8 / Math.max(1, members.length), 0.3);
        members.forEach((n, k) => {
            const a = center + (k - (members.length - 1) / 2) * step;
            const r = sectorRadius + (k % 2) * 44;
            n.ax = Math.cos(a) * r;
            n.ay = Math.sin(a) * r;
        });
    });
    const l1ById = new Map(l1.map((n) => [n.id, n]));
    for (const n of l2) {
        const parent = l1ById.get(n.parentId!)!;
        const a = Math.atan2(parent.ay, parent.ax) + (n.rank - (L2_PER_PARENT - 1) / 2) * 0.12;
        const r = Math.hypot(parent.ax, parent.ay) + 70;
        n.ax = Math.cos(a) * r;
        n.ay = Math.sin(a) * r;
    }

    for (const n of [...l1, ...l2]) n.ring = Math.hypot(n.ax, n.ay);

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

/** Unpins dragged words and drops every word next to its anchor so the layout can settle again. */
function scatterAroundAnchors(nodes: AtlasNode[]) {
    for (const n of nodes) {
        if (n.level === 0) continue;
        n.fx = undefined;
        n.fy = undefined;
        n.x = n.ax + (Math.random() - 0.5) * 20;
        n.y = n.ay + (Math.random() - 0.5) * 20;
    }
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

const PALETTE: Record<Theme, {
    bg: string; ink: string; muted: string; halo: string; edgeAlpha: number; bubbleFill: string;
    /** Progress ring around a node (familiarity); weak words get their own warning colour. */
    ring: string; weakRing: string;
    /** Centre word: highlight, body and rim of its gradient. */
    center: [string, string, string];
    /** Dark theme lets nodes glow; light theme gives them a soft drop shadow instead. */
    glow: boolean;
}> = {
    dark: {
        bg: '#05070d', ink: '#eaf2ff', muted: '#8ca3c4', halo: 'rgba(5,7,13,0.92)', edgeAlpha: 0.45,
        bubbleFill: 'rgba(167,139,250,0.06)', ring: 'rgba(234,242,255,0.9)', weakRing: '#fb7185',
        center: ['#e0f2fe', '#38bdf8', '#075985'], glow: true,
    },
    light: {
        bg: '#f1ede4', ink: '#20302c', muted: '#61706b', halo: 'rgba(241,237,228,0.95)', edgeAlpha: 0.5,
        bubbleFill: 'rgba(139,92,246,0.05)', ring: 'rgba(32,48,44,0.85)', weakRing: '#e11d48',
        center: ['#a7f3d0', '#1b6c53', '#0f3d2e'], glow: false,
    },
};
type Palette = (typeof PALETTE)[Theme];

const FAMILIARITY_ORDER: Array<Familiarity | 'new'> = ['new', 'seen', 'weak', 'learning', 'mastered'];
/** Share of the progress ring drawn for each familiarity level. */
const RING_FRACTION: Record<Familiarity, number> = { seen: 0.25, weak: 1, learning: 0.66, mastered: 1 };

/** Blend two #rrggbb colours; t = 0 gives `hex`, t = 1 gives `other`. */
function mix(hex: string, other: string, t: number): string {
    const a = parseInt(hex.slice(1), 16), b = parseInt(other.slice(1), 16);
    const channel = (shift: number) => {
        const from = (a >> shift) & 255, to = (b >> shift) & 255;
        return Math.round(from + (to - from) * t);
    };
    return `rgb(${channel(16)}, ${channel(8)}, ${channel(0)})`;
}

/** Solid "jewel" node: a radial gradient in the relation colour, glowing on dark, shadowed on paper. */
function paintJewel(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, stops: [string, string, string], palette: Palette, hovered: boolean) {
    const [highlight, body, rim] = stops;
    ctx.save();
    if (palette.glow) {
        ctx.shadowColor = body;
        ctx.shadowBlur = hovered ? 22 : 12;
    } else {
        ctx.shadowColor = 'rgba(60, 45, 20, 0.28)';
        ctx.shadowBlur = hovered ? 8 : 4;
        ctx.shadowOffsetY = 1;
    }
    const gradient = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r);
    gradient.addColorStop(0, highlight);
    gradient.addColorStop(0.55, body);
    gradient.addColorStop(1, rim);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = gradient;
    ctx.fill();
    ctx.restore();
}

/** Gradient stops for a relation colour. */
function jewelStops(color: string): [string, string, string] {
    return [mix(color, '#ffffff', 0.55), color, mix(color, '#000000', 0.3)];
}

/** Familiarity as a progress ring: a quarter once seen, two thirds while learning, closed when mastered. */
function paintProgressRing(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, level: Familiarity | undefined, palette: Palette, scale: number) {
    if (!level) return;
    const radius = r + 3.5;
    const color = level === 'weak' ? palette.weakRing : palette.ring;
    const fraction = RING_FRACTION[level];
    ctx.save();
    ctx.lineWidth = (level === 'mastered' ? 2.4 : 2) / scale;
    ctx.lineCap = 'round';
    ctx.strokeStyle = color;
    if (fraction < 1) {
        ctx.globalAlpha *= 0.22;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha /= 0.22;
    }
    ctx.beginPath();
    ctx.arc(x, y, radius, -Math.PI / 2, -Math.PI / 2 + fraction * Math.PI * 2);
    ctx.stroke();
    ctx.restore();
}

/** Legend swatch: a neutral dot with the same progress ring the graph draws. */
function RingIcon({ level, palette }: { level: Familiarity | 'new'; palette: Palette }) {
    const circumference = 2 * Math.PI * 6;
    const fraction = level === 'new' ? 0 : RING_FRACTION[level];
    const color = level === 'weak' ? palette.weakRing : palette.ring;
    return (
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="8" cy="8" r="3.2" fill={palette.muted} />
            {fraction > 0 && fraction < 1 && <circle cx="8" cy="8" r="6" fill="none" stroke={color} strokeOpacity="0.22" strokeWidth="1.6" />}
            {fraction > 0 && (
                <circle
                    cx="8" cy="8" r="6" fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round"
                    strokeDasharray={`${fraction * circumference} ${circumference}`} transform="rotate(-90 8 8)"
                />
            )}
        </svg>
    );
}

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

    // Fetched state remembers what it was fetched for, so a new word never shows stale results
    // and nothing has to be reset from inside an effect.
    const [fetched, setFetched] = useState<{ word: string; graph: GraphData } | null>(null);
    const [known, setKnown] = useState<{ graph: GraphData; states: Record<string, Familiarity> } | null>(null);
    const [expandedByWord, setExpandedByWord] = useState<Record<string, RelationGroup[]>>({});
    const [hidden, setHidden] = useState<Set<RelationGroup>>(new Set());
    const [secondDegree, setSecondDegree] = useState(false);
    const [hovered, setHovered] = useState<AtlasNode | null>(null);
    const [size, setSize] = useState({ width: 0, height: 0 });
    const [zoomK, setZoomK] = useState(1);

    const containerRef = useRef<HTMLDivElement | null>(null);
    const resizeObserver = useRef<ResizeObserver | null>(null);
    const fgRef = useRef<ForceGraphMethods<NodeObject<AtlasNode>, LinkObject<AtlasNode, AtlasLink>> | undefined>(undefined);
    const tooltipRef = useRef<HTMLDivElement>(null);
    const pillRefs = useRef(new Map<RelationGroup, HTMLDivElement>());
    const fittedRef = useRef(false);
    const zoomFrame = useRef<number | null>(null);

    const data = word && fetched?.word === word ? fetched.graph : null;
    const loading = !!word && !data;
    const familiarity = useMemo(() => (known && known.graph === data ? known.states : {}), [known, data]);
    const expanded = useMemo(() => new Set(word ? expandedByWord[word] ?? [] : []), [expandedByWord, word]);

    // ---- data -------------------------------------------------------------
    useEffect(() => {
        if (!word) return;
        const controller = new AbortController();
        fetch(`/api/fission?word=${encodeURIComponent(word)}`, { signal: controller.signal })
            .then((res) => res.json() as Promise<GraphData>)
            .then((graph) => setFetched({ word, graph }))
            .catch((err) => { if (err?.name !== 'AbortError') setFetched({ word, graph: { nodes: [], links: [] } }); });
        return () => controller.abort();
    }, [word]);

    useEffect(() => {
        if (!data?.nodes.length) return;
        const controller = new AbortController();
        fetch('/api/user/word-states', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ words: data.nodes.map((n) => n.id) }),
            signal: controller.signal,
        })
            .then((res) => (res.ok ? res.json() : { states: {} }))
            .then((body: { states?: Record<string, Familiarity> }) => setKnown({ graph: data, states: body.states ?? {} }))
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
    // Callback ref: the graph area only exists once a word is selected, after the first render.
    const attachGraphArea = useCallback((el: HTMLDivElement | null) => {
        resizeObserver.current?.disconnect();
        containerRef.current = el;
        if (!el) return;
        resizeObserver.current = new ResizeObserver(([entry]) => {
            const { width, height } = entry.contentRect;
            setSize({ width: Math.round(width), height: Math.round(height) });
        });
        resizeObserver.current.observe(el);
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
        fg.d3Force('charge')?.strength(-40).distanceMax(160);
        fg.d3Force('link')
            ?.distance((l: AtlasLink) => (l.level === 1 ? Math.hypot((l.target as AtlasNode).ax, (l.target as AtlasNode).ay) : 42))
            .strength((l: AtlasLink) => (l.level === 1 ? 0.02 : 0.35));
        fg.d3Force('x', forceX<AtlasNode>((n) => n.ax).strength((n) => (n.level === 0 ? 0 : 0.2)));
        fg.d3Force('y', forceY<AtlasNode>((n) => n.ay).strength((n) => (n.level === 0 ? 0 : 0.2)));
        fg.d3Force('ring', forceRadial<AtlasNode>((n) => n.ring ?? 0, 0, 0).strength((n) => (n.level === 0 ? 0 : 0.18)));
        fg.d3Force('collide', forceCollide<AtlasNode>((n) => {
            if (n.level === 0) return RADIUS.center + 14;
            if (n.level === 2) return RADIUS.l2 + 10;
            return RADIUS.l1 + Math.min(34, n.name.length * 3.2) + 6;
        }).strength(0.9).iterations(3));
        fg.d3ReheatSimulation();
    }, [view]);
    useEffect(() => { applyForces(); }, [applyForces]);

    const fit = useCallback((ms = 500) => fgRef.current?.zoomToFit(ms, 84), []);

    // Panels are resizable: keep the graph framed when the available space changes.
    useEffect(() => {
        if (!fittedRef.current) return;
        const timer = window.setTimeout(() => fit(250), 150);
        return () => window.clearTimeout(timer);
    }, [size, fit]);

    const relayout = useCallback(() => {
        scatterAroundAnchors(view?.nodes ?? []);
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
            // Graph point the pill hangs from, and the direction it extends in (away from its words).
            let x: number, y: number, ux: number, uy: number;
            if (group === 'family') {
                const r = Math.max(...members.map((n) => Math.hypot(n.x!, n.y!))) + RADIUS.l1 + 14;
                x = 0; y = -r; ux = 0; uy = -1;
            } else {
                const anchor = view.anchors.get(group);
                if (!anchor) { el.style.visibility = 'hidden'; continue; }
                const d = Math.hypot(anchor.x, anchor.y) || 1;
                ux = anchor.x / d; uy = anchor.y / d;
                const reach = Math.max(...members.map((n) => n.x! * ux + n.y! * uy));
                x = ux * (reach + 26);
                y = uy * (reach + 26);
            }
            const p = fg.graph2ScreenCoords(x, y);
            const w = el.offsetWidth, h = el.offsetHeight;
            // Top-left corner of the pill so that it sits on the far side of the point.
            let left = p.x - w / 2 + ux * w / 2;
            // Words carry their label underneath, so leave room for it below the cluster.
            let top = p.y - h / 2 + uy * h / 2 + (uy > 0 ? 16 : 0);
            left = Math.min(Math.max(left, 6), size.width - w - 6);
            top = Math.min(Math.max(top, 6), size.height - h - 52);
            el.style.visibility = 'visible';
            el.style.transform = `translate(${left}px, ${top}px)`;
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
        const level = familiarity[node.id];
        ctx.save();
        if (dim) ctx.globalAlpha = 0.35;

        if (node.level === 0) {
            paintJewel(ctx, x, y, RADIUS.center, palette.center, palette, isHovered);
            paintProgressRing(ctx, x, y, RADIUS.center + 1.5, level, palette, scale);
        } else if (node.level === 1) {
            const r = RADIUS.l1 * (isHovered ? 1.2 : 1);
            if (node.placeholder) {
                // No dictionary entry yet: keep it hollow and dashed.
                ctx.beginPath();
                ctx.arc(x, y, r, 0, Math.PI * 2);
                ctx.fillStyle = palette.bg;
                ctx.fill();
                ctx.setLineDash([3 / scale, 3 / scale]);
                ctx.strokeStyle = palette.muted;
                ctx.lineWidth = 1.5 / scale;
                ctx.stroke();
            } else {
                paintJewel(ctx, x, y, r, jewelStops(GROUP_COLORS[node.group!]), palette, isHovered);
                paintProgressRing(ctx, x, y, r, level, palette, scale);
            }
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

            <div ref={attachGraphArea} className="relative min-h-0 flex-1">
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
                                onClick={() => setExpandedByWord((prev) => {
                                    const current = prev[word] ?? [];
                                    return { ...prev, [word]: current.includes(g) ? current.filter((x) => x !== g) : [...current, g] };
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
                            <RingIcon level={f} palette={palette} />
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
