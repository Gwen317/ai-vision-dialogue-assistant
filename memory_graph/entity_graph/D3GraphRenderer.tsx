import React, { useEffect, useRef, useState, useCallback } from 'react';
import * as d3 from 'd3';
import { FileText, Clock, Link2 } from 'lucide-react';

// ─────────────────────────────────────────────
//  类型定义
// ─────────────────────────────────────────────

export interface GraphNode extends d3.SimulationNodeDatum {
  id: string;
  label: string;
  type: 'device' | 'capacitor' | 'tool' | 'wire' | 'concept' | 'person';
  image?: string;          // Base64 截图
  details?: string;        // AI 分析记录
  firstSeen?: string;      // ISO8601 首次出现时间
}

export interface GraphLink extends d3.SimulationLinkDatum<GraphNode> {
  source: string | GraphNode;
  target: string | GraphNode;
  relation: string;
}

interface D3GraphRendererProps {
  nodes: GraphNode[];
  links: GraphLink[];
  onNodeClick?: (node: GraphNode) => void;
}

// ─────────────────────────────────────────────
//  节点类型颜色映射
// ─────────────────────────────────────────────

const NODE_COLORS: Record<GraphNode['type'], string> = {
  device: '#00f2fe',      // 青色 — 设备
  capacitor: '#ff007f',   // 品红 — 电容
  tool: '#39ff14',        // 荧光绿 — 工具
  wire: '#ffd700',        // 金色 — 导线
  concept: '#bc13fe',     // 紫色 — 普通概念
  person: '#ff9f0a'       // 橙色 — 人物/人脸
};

const NODE_TYPE_LABELS: Record<GraphNode['type'], string> = {
  device: '设备',
  capacitor: '电容',
  tool: '工具',
  wire: '导线',
  concept: '概念',
  person: '人物'
};

// ─────────────────────────────────────────────
//  悬浮卡片组件
// ─────────────────────────────────────────────

interface TooltipData {
  node: GraphNode;
  x: number;
  y: number;
}

const TooltipCard: React.FC<{ data: TooltipData | null; onClose: () => void }> = ({ data, onClose }) => {
  if (!data) return null;
  const { node, x, y } = data;
  const color = NODE_COLORS[node.type] || '#bc13fe';

  return (
    <div
      style={{
        position: 'absolute',
        left: Math.min(x + 16, window.innerWidth - 320),
        top: y - 10,
        width: 280,
        maxHeight: 360,
        background: 'rgba(10, 14, 28, 0.92)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        border: `1px solid ${color}40`,
        borderRadius: 12,
        padding: 16,
        color: '#e0e6ed',
        fontFamily: "'Inter', 'Noto Sans SC', sans-serif",
        fontSize: 13,
        boxShadow: `0 0 24px ${color}30, 0 8px 32px rgba(0,0,0,0.5)`,
        zIndex: 1000,
        overflow: 'auto',
        animation: 'tooltipFadeIn 0.2s ease-out'
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* 关闭按钮 */}
      <button
        onClick={onClose}
        style={{
          position: 'absolute',
          top: 8,
          right: 10,
          background: 'none',
          border: 'none',
          color: '#8a99ad',
          fontSize: 16,
          cursor: 'pointer',
          padding: '2px 6px',
          borderRadius: 4
        }}
      >
        ✕
      </button>

      {/* 标题栏 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span
          style={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            background: color,
            boxShadow: `0 0 8px ${color}`,
            flexShrink: 0
          }}
        />
        <span style={{ fontWeight: 700, fontSize: 15, color: '#fff' }}>{node.label}</span>
        <span
          style={{
            fontSize: 11,
            padding: '2px 8px',
            borderRadius: 10,
            background: `${color}20`,
            color,
            border: `1px solid ${color}40`
          }}
        >
          {NODE_TYPE_LABELS[node.type] || node.type}
        </span>
      </div>

      {/* 截图缩略图 */}
      {node.image && (
        <div style={{ marginBottom: 10, borderRadius: 8, overflow: 'hidden', border: `1px solid ${color}30` }}>
          <img
            src={node.image.startsWith('data:') ? node.image : `data:image/jpeg;base64,${node.image}`}
            alt={node.label}
            style={{ width: '100%', height: 'auto', display: 'block' }}
          />
        </div>
      )}

      {/* AI 分析记录 */}
      {node.details && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 11, color: '#8a99ad', marginBottom: 4, display: 'flex', alignItems: 'center', gap: '5px' }}>
            <FileText size={12} />
            <span>AI 分析记录</span>
          </div>
          <div style={{ lineHeight: 1.5, color: '#c0c8d4' }}>{node.details}</div>
        </div>
      )}

      {/* 首次出现时间 */}
      {node.firstSeen && (
        <div style={{ fontSize: 11, color: '#6b7a8d', marginTop: 8, display: 'flex', alignItems: 'center', gap: '5px' }}>
          <Clock size={12} />
          <span>首次发现：{new Date(node.firstSeen).toLocaleString('zh-CN')}</span>
        </div>
      )}
    </div>
  );
};

// ─────────────────────────────────────────────
//  主渲染组件
// ─────────────────────────────────────────────

export const D3GraphRenderer: React.FC<D3GraphRendererProps> = ({ nodes, links, onNodeClick }) => {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [tooltip, setTooltip] = useState<TooltipData | null>(null);

  const handleCloseTooltip = useCallback(() => setTooltip(null), []);

  useEffect(() => {
    if (!svgRef.current) return;

    const width = 600;
    const height = 400;

    // Clear previous elements
    d3.select(svgRef.current).selectAll('*').remove();

    const svg = d3.select(svgRef.current)
      .attr('width', '100%')
      .attr('height', '100%')
      .attr('viewBox', `0 0 ${width} ${height}`)
      .style('background', '#0b0f19');

    // ─── Defs: 箭头 + 呼吸光晕滤镜 ───
    const defs = svg.append('defs');

    // Arrow marker
    defs.append('marker')
      .attr('id', 'arrow')
      .attr('viewBox', '0 -5 10 10')
      .attr('refX', 22)
      .attr('refY', 0)
      .attr('markerWidth', 6)
      .attr('markerHeight', 6)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M0,-5L10,0L0,5')
      .attr('fill', '#00f2fe');

    // Neon glow filters for each node type
    Object.entries(NODE_COLORS).forEach(([type, color]) => {
      const filter = defs.append('filter')
        .attr('id', `glow-${type}`)
        .attr('x', '-50%').attr('y', '-50%')
        .attr('width', '200%').attr('height', '200%');
      
      filter.append('feGaussianBlur')
        .attr('stdDeviation', '3')
        .attr('result', 'blur');
      
      filter.append('feFlood')
        .attr('flood-color', color)
        .attr('flood-opacity', '0.6')
        .attr('result', 'color');
      
      filter.append('feComposite')
        .attr('in', 'color')
        .attr('in2', 'blur')
        .attr('operator', 'in')
        .attr('result', 'glow');
      
      const merge = filter.append('feMerge');
      merge.append('feMergeNode').attr('in', 'glow');
      merge.append('feMergeNode').attr('in', 'SourceGraphic');
    });

    // ─── 力学仿真 ───
    const simulation = d3.forceSimulation<GraphNode>(nodes)
      .force('link', d3.forceLink<GraphNode, GraphLink>(links).id(d => d.id).distance(100))
      .force('charge', d3.forceManyBody().strength(-180))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collision', d3.forceCollide().radius(30));

    // ─── 连线 ───
    const link = svg.append('g')
      .selectAll('line')
      .data(links)
      .enter().append('line')
      .attr('stroke', 'rgba(0, 242, 254, 0.15)')
      .attr('stroke-width', 1.5)
      .attr('marker-end', 'url(#arrow)');

    // 连线标签
    const linkText = svg.append('g')
      .selectAll('text')
      .data(links)
      .enter().append('text')
      .style('fill', '#5a6a7e')
      .style('font-size', '9px')
      .style('font-family', "'Inter', sans-serif")
      .style('pointer-events', 'none')
      .text(d => d.relation);

    // ─── 节点组 ───
    const node = svg.append('g')
      .selectAll('g')
      .data(nodes)
      .enter().append('g')
      .style('cursor', 'pointer')
      .on('click', (event, d) => {
        // 弹出悬浮卡片
        const svgRect = svgRef.current!.getBoundingClientRect();
        const containerRect = containerRef.current?.getBoundingClientRect();
        const offsetX = containerRect ? containerRect.left : svgRect.left;
        const offsetY = containerRect ? containerRect.top : svgRect.top;
        
        const screenX = (d.x! / width) * svgRect.width + offsetX;
        const screenY = (d.y! / height) * svgRect.height + offsetY;
        
        setTooltip({ node: d, x: screenX, y: screenY });
        onNodeClick?.(d);
      })
      .call(d3.drag<SVGGElement, GraphNode>()
        .on('start', dragstarted)
        .on('drag', dragged)
        .on('end', dragended) as any);

    // 外环光晕（呼吸动效载体）
    node.append('circle')
      .attr('r', 16)
      .attr('fill', 'none')
      .attr('stroke', d => NODE_COLORS[d.type] || '#bc13fe')
      .attr('stroke-width', 1.5)
      .attr('stroke-opacity', 0.3)
      .attr('class', 'neon-breath');

    // 核心圆圈
    node.append('circle')
      .attr('r', 12)
      .attr('fill', d => NODE_COLORS[d.type] || '#bc13fe')
      .attr('fill-opacity', 0.85)
      .attr('filter', d => `url(#glow-${d.type})`);

    // 节点内部图标（根据类型显示不同符号）
    node.append('text')
      .attr('text-anchor', 'middle')
      .attr('dy', 4)
      .style('font-size', '10px')
      .style('pointer-events', 'none')
      .style('fill', '#0b0f19')
      .text(d => {
        switch (d.type) {
          case 'device': return '⏻';
          case 'capacitor': return '⊥';
          case 'tool': return '⚙';
          case 'wire': return '∼';
          case 'person': return '👤';
          default: return '◆';
        }
      });

    // 节点标签
    node.append('text')
      .attr('dy', 28)
      .attr('text-anchor', 'middle')
      .style('fill', '#c8d0dc')
      .style('font-size', '11px')
      .style('font-family', "'Inter', 'Noto Sans SC', sans-serif")
      .style('font-weight', '500')
      .style('pointer-events', 'none')
      .text(d => d.label);

    // ─── 呼吸动效 (d3.timer) ───
    const breathTimer = d3.timer((elapsed) => {
      // 正弦波驱动光晕半径与透明度
      const t = elapsed / 1000;
      svg.selectAll('.neon-breath')
        .attr('r', 16 + Math.sin(t * 1.8) * 3)
        .attr('stroke-opacity', 0.2 + Math.sin(t * 1.8) * 0.15);
    });

    // ─── Tick 更新 ───
    simulation.on('tick', () => {
      link
        .attr('x1', d => (d.source as GraphNode).x!)
        .attr('y1', d => (d.source as GraphNode).y!)
        .attr('x2', d => (d.target as GraphNode).x!)
        .attr('y2', d => (d.target as GraphNode).y!);

      node
        .attr('transform', d => `translate(${d.x}, ${d.y})`);

      linkText
        .attr('x', d => ((d.source as GraphNode).x! + (d.target as GraphNode).x!) / 2)
        .attr('y', d => ((d.source as GraphNode).y! + (d.target as GraphNode).y!) / 2);
    });

    // ─── 拖拽回调 ───
    function dragstarted(event: any, d: GraphNode) {
      if (!event.active) simulation.alphaTarget(0.3).restart();
      d.fx = d.x;
      d.fy = d.y;
      setTooltip(null);
    }

    function dragged(event: any, d: GraphNode) {
      d.fx = event.x;
      d.fy = event.y;
    }

    function dragended(event: any, d: GraphNode) {
      if (!event.active) simulation.alphaTarget(0);
      d.fx = null;
      d.fy = null;
    }

    return () => {
      simulation.stop();
      breathTimer.stop();
    };
  }, [nodes, links, onNodeClick]);

  return (
    <div
      ref={containerRef}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        minHeight: '400px',
        borderRadius: 12,
        border: '1px solid rgba(0, 242, 254, 0.1)',
        overflow: 'hidden',
        background: '#0b0f19'
      }}
      onClick={handleCloseTooltip}
    >
      {/* 注入 CSS 动画 */}
      <style>{`
        @keyframes tooltipFadeIn {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>

      <svg ref={svgRef}></svg>

      {/* 悬浮卡片弹出层 */}
      <TooltipCard data={tooltip} onClose={handleCloseTooltip} />

      {/* 右下角模式指示器 */}
      {nodes.length > 0 && (
        <div
          style={{
            position: 'absolute',
            bottom: 8,
            right: 12,
            fontSize: 10,
            color: '#4a5568',
            fontFamily: "'Inter', monospace"
          }}
        >
          {nodes.length} nodes · {links.length} links
        </div>
      )}
    </div>
  );
};
