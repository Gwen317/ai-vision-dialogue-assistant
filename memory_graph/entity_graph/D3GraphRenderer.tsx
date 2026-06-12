import React, { useEffect, useRef } from 'react';
import * as d3 from 'd3';

export interface GraphNode extends d3.SimulationNodeDatum {
  id: string;
  label: string;
  type: 'device' | 'capacitor' | 'tool' | 'wire' | 'concept';
  image?: string;
  details?: string;
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

export const D3GraphRenderer: React.FC<D3GraphRendererProps> = ({ nodes, links, onNodeClick }) => {
  const svgRef = useRef<SVGSVGElement | null>(null);

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

    // Arrow marker for link direction
    svg.append('defs').append('marker')
      .attr('id', 'arrow')
      .attr('viewBox', '0 -5 10 10')
      .attr('refX', 20)
      .attr('refY', 0)
      .attr('markerWidth', 6)
      .attr('markerHeight', 6)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M0,-5L10,0L0,5')
      .attr('fill', '#00f2fe');

    const simulation = d3.forceSimulation<GraphNode>(nodes)
      .force('link', d3.forceLink<GraphNode, GraphLink>(links).id(d => d.id).distance(100))
      .force('charge', d3.forceManyBody().strength(-150))
      .force('center', d3.forceCenter(width / 2, height / 2));

    // Links lines
    const link = svg.append('g')
      .selectAll('line')
      .data(links)
      .enter().append('line')
      .attr('stroke', 'rgba(0, 242, 254, 0.2)')
      .attr('stroke-width', 2)
      .attr('marker-end', 'url(#arrow)');

    // Links labels
    const linkText = svg.append('g')
      .selectAll('text')
      .data(links)
      .enter().append('text')
      .style('fill', '#8a99ad')
      .style('font-size', '10px')
      .style('pointer-events', 'none')
      .text(d => d.relation);

    // Nodes elements
    const node = svg.append('g')
      .selectAll('g')
      .data(nodes)
      .enter().append('g')
      .style('cursor', 'pointer')
      .on('click', (_, d) => onNodeClick?.(d))
      .call(d3.drag<SVGGElement, GraphNode>()
        .on('start', dragstarted)
        .on('drag', dragged)
        .on('end', dragended) as any);

    // Neon circle nodes
    node.append('circle')
      .attr('r', 12)
      .attr('fill', d => {
        if (d.type === 'device') return '#00f2fe';
        if (d.type === 'capacitor') return '#ff007f';
        if (d.type === 'tool') return '#39ff14';
        return '#bc13fe';
      })
      .style('filter', 'drop-shadow(0px 0px 5px var(--node-glow))')
      .style('--node-glow', d => {
        if (d.type === 'device') return '#00f2fe';
        if (d.type === 'capacitor') return '#ff007f';
        if (d.type === 'tool') return '#39ff14';
        return '#bc13fe';
      });

    // Node texts
    node.append('text')
      .attr('dy', 25)
      .attr('text-anchor', 'middle')
      .style('fill', '#ffffff')
      .style('font-size', '12px')
      .style('font-family', 'Orbitron, sans-serif')
      .text(d => d.label);

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

    function dragstarted(event: any, d: GraphNode) {
      if (!event.active) simulation.alphaTarget(0.3).restart();
      d.fx = d.x;
      d.fy = d.y;
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
    };
  }, [nodes, links, onNodeClick]);

  return (
    <div style={{ width: '100%', height: '100%', minHeight: '400px', borderRadius: '12px', border: '1px solid rgba(0, 242, 254, 0.1)', overflow: 'hidden' }}>
      <svg ref={svgRef}></svg>
    </div>
  );
};
