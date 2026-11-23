import React from 'react';
import {BODY, cardGrid, clamp, fitFont, flowchartLayout, pageState, smooth, stackState} from './layout.js';

const ordinal = number => String(number + 1).padStart(2, '0');

function FitText({text, width, height, maximum = 28, minimum = 14, lineHeight = 1.2, className = '', style = {}}) {
  const fontSize = fitFont(text, width, height, maximum, minimum, lineHeight);
  return <div className={`engine-fit-text ${className}`} data-fit-text="true" style={{fontSize, lineHeight, width, height, ...style}}>{text}</div>;
}

function Heading({title, eyebrow, note}) {
  return <header className="engine-heading">
    <div className="engine-heading-meta"><span className="engine-eyebrow">{eyebrow}</span>{note && <span>{note}</span>}</div>
    <FitText text={title} width={BODY.width} height={104} maximum={46} minimum={28} lineHeight={1.12} className="engine-heading-title" />
  </header>;
}

function TitleScene({props, progress}) {
  const reveal = smooth(progress / 0.22);
  return <section className="engine-title-scene" data-layout-bound="true">
    <div className="engine-eyebrow">A VISUAL EXPLANATION</div>
    <div className="engine-title-mark" aria-hidden="true"><span /><span /><span /></div>
    <FitText text={props.title} width={1080} height={300} maximum={82} minimum={38} lineHeight={1.08} className="engine-title-copy" style={{transform: `translateY(${(1 - reveal) * 14}px)`}} />
    {props.subtitle && <FitText text={props.subtitle} width={1060} height={142} maximum={29} minimum={20} lineHeight={1.25} className="engine-title-subtitle" />}
    <div className="engine-title-rule" aria-hidden="true"><div style={{transform: `scaleX(${reveal})`}} /></div>
  </section>;
}

function CardsScene({props, progress, mode}) {
  const entries = mode === 'STEPS' ? props.steps : props.points;
  const page = pageState(progress, entries.length);
  const visible = entries.slice(page.start, page.end);
  const grid = cardGrid(visible.length);
  const active = Math.min(visible.length - 1, Math.floor(page.progress * visible.length));
  return <>
    <Heading title={props.title} eyebrow={mode === 'STEPS' ? 'STEP BY STEP' : 'KEY TAKEAWAYS'} note={`${ordinal(page.start)}–${String(page.end).padStart(2, '0')} / ${String(entries.length).padStart(2, '0')}`} />
    <div className="engine-body engine-cards" data-layout-bound="true" style={{gridTemplateColumns: `repeat(${grid.columns}, 1fr)`, gridTemplateRows: `repeat(${grid.rows}, 1fr)`, gap: grid.gap}}>
      {visible.map((text, localIndex) => {
        const originalIndex = page.start + localIndex;
        const reveal = smooth((page.progress - localIndex * 0.07) / 0.15);
        return <article key={originalIndex} className={`engine-content-card ${active === localIndex ? 'is-active' : ''}`} data-layout-bound="true" style={{opacity: 0.48 + reveal * 0.52, transform: `translateY(${(1 - reveal) * 7}px)`}}>
          <div className="engine-card-top"><span className="engine-number-badge">{mode === 'STEPS' ? ordinal(originalIndex) : <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>}</span><span>{mode === 'STEPS' ? 'STEP' : 'KEY POINT'} {originalIndex + 1}</span><span className="engine-card-dot" /></div>
          <FitText text={text} width={grid.cardWidth - 44} height={grid.cardHeight - 88} maximum={visible.length === 1 ? 40 : 30} minimum={14} lineHeight={1.2} className="engine-card-copy" />
        </article>;
      })}
    </div>
  </>;
}

function StackFigure({items, progress, compact = false}) {
  const state = stackState(progress, items.length);
  const figureHeight = compact ? 202 : 334;
  const slotHeight = Math.min(48, (figureHeight - 10 - (items.length - 1) * 4) / items.length);
  return <div className="engine-stack-figure" style={{height: figureHeight}}>
    <div className="engine-stack-direction" aria-hidden="true"><svg viewBox="0 0 36 120" width="30" height="120"><path d={state.phase === 'PUSH' ? 'M18 108V12M8 25L18 12L28 25' : 'M18 12V108M8 95L18 108L28 95'} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg></div>
    <div className="engine-stack-slots">
      {items.map((_, index) => <div key={index} className={`engine-stack-slot ${index < state.visible ? 'is-filled' : ''} ${index === state.active && state.visible > 0 ? 'is-focused' : ''}`} style={{height: slotHeight, fontSize: compact && items.length > 8 ? 10 : 13}}><span>{ordinal(index)}</span><span className="engine-stack-slot-line" /></div>)}
    </div>
  </div>;
}

function QueueFigure({items, progress, compact = false}) {
  const done = progress >= 0.995;
  const active = Math.min(items.length - 1, Math.floor(clamp(progress) * items.length));
  const columns = Math.min(6, items.length);
  return <div className={`engine-queue-figure ${compact ? 'is-compact' : ''}`} style={{gridTemplateColumns: `repeat(${columns}, 1fr)`}}>
    {items.map((_, index) => <div key={index} className={`engine-queue-slot ${index < active || done ? 'is-processed' : ''} ${index === active && !done ? 'is-focused' : ''}`}><span>{ordinal(index)}</span><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 12h15m-5-5 5 5-5 5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg></div>)}
  </div>;
}

function StructureFocus({items, progress, type, width, height, compact = false}) {
  const state = type === 'STACK' ? stackState(progress, items.length) : null;
  const done = progress >= 0.995;
  const active = type === 'STACK' ? state.active : Math.min(items.length - 1, Math.floor(progress * items.length));
  const text = done ? type === 'STACK' ? 'All items returned' : 'All items processed' : items[active];
  const label = type === 'STACK' ? state.phase === 'PUSH' ? 'ADDING TO THE STACK' : 'RETURNING FROM THE STACK' : 'PROCESSING THE NEXT ITEM';
  return <div className={`engine-structure-focus ${compact ? 'is-compact' : ''}`} data-layout-bound="true" style={{width, height}}>
    <div className="engine-eyebrow">{done ? 'COMPLETE' : label}</div>
    <FitText text={text} width={width - 44} height={height - (compact ? 62 : 82)} maximum={compact ? 27 : 42} minimum={compact ? 13 : 18} lineHeight={1.18} className="engine-focus-copy" />
  </div>;
}

function StackQueueScene({props, progress}) {
  const mode = props.layout || 'STACK';
  const dual = mode === 'STACK_AND_QUEUE';
  const types = dual ? ['STACK', 'QUEUE'] : [mode];
  return <>
    <Heading title={props.title} eyebrow={dual ? 'TWO WAYS TO ORGANIZE WORK' : mode === 'STACK' ? 'LAST IN, FIRST OUT' : 'FIRST IN, FIRST OUT'} note={`${props.items.length} ${props.items.length === 1 ? 'item' : 'items'}`} />
    <div className={`engine-body engine-structures ${dual ? 'is-dual' : ''}`} data-layout-bound="true">
      {types.map(type => <section key={type} className={`engine-structure-panel engine-panel-${type.toLowerCase()}`} data-layout-bound="true">
        <div className="engine-panel-label"><span>{type === 'STACK' ? 'Stack' : 'Queue'}</span><span>{type === 'STACK' ? 'LIFO' : 'FIFO'}</span></div>
        {type === 'STACK' ? <StackFigure items={props.items} progress={progress} compact={dual} /> : <QueueFigure items={props.items} progress={progress} compact={dual} />}
        {dual && <StructureFocus items={props.items} progress={progress} type={type} width={BODY.width / 2 - 50} height={130} compact />}
      </section>)}
      {!dual && <StructureFocus items={props.items} progress={progress} type={mode} width={472} height={BODY.height} />}
    </div>
  </>;
}

function edgeGeometry(from, to, index) {
  const fx = from.x + from.width / 2;
  const fy = from.y + from.height / 2;
  const tx = to.x + to.width / 2;
  const ty = to.y + to.height / 2;
  if (from.id === to.id) {
    const right = from.x + from.width;
    return {path: `M${right},${fy - 20} C${right + 16},${fy - 38} ${right + 16},${fy + 38} ${right},${fy + 20}`, x: right + 9, y: fy};
  }
  const dx = tx - fx;
  const dy = ty - fy;
  const sourceScale = Math.min(Math.abs(dx) < 0.001 ? Infinity : from.width / 2 / Math.abs(dx), Math.abs(dy) < 0.001 ? Infinity : from.height / 2 / Math.abs(dy));
  const targetScale = Math.min(Math.abs(dx) < 0.001 ? Infinity : to.width / 2 / Math.abs(dx), Math.abs(dy) < 0.001 ? Infinity : to.height / 2 / Math.abs(dy));
  const x1 = fx + dx * sourceScale;
  const y1 = fy + dy * sourceScale;
  const x2 = tx - dx * targetScale;
  const y2 = ty - dy * targetScale;
  const length = Math.hypot(dx, dy);
  const bend = (index % 3 - 1) * 8;
  const mx = (x1 + x2) / 2 - dy / length * bend;
  const my = (y1 + y2) / 2 + dx / length * bend;
  return {path: `M${x1},${y1} Q${mx},${my} ${x2},${y2}`, x: mx, y: my};
}

function FlowchartScene({scene, progress}) {
  const props = scene.visualProps;
  const nodes = flowchartLayout(props.nodes);
  const byId = new Map(nodes.map(node => [node.id, node]));
  const active = Math.min(props.edges.length - 1, Math.floor(progress * props.edges.length));
  const activeEdge = props.edges[active];
  const currentDescription = activeEdge.label || `${byId.get(activeEdge.from).label} → ${byId.get(activeEdge.to).label}`;
  const markerId = `engine-arrow-${scene.sceneId}`;
  return <>
    <Heading title={props.title} eyebrow="CONNECTED IDEAS" note={`${props.nodes.length} nodes · ${props.edges.length} connections`} />
    <section className="engine-body engine-flow" data-layout-bound="true">
      <svg className="engine-flow-graph" viewBox={`0 0 ${BODY.width} 344`} width={BODY.width} height={344} role="img" aria-label={props.title}>
        <defs><marker id={markerId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z" fill="currentColor" /></marker></defs>
        {props.edges.map((edge, index) => {
          const geometry = edgeGeometry(byId.get(edge.from), byId.get(edge.to), index);
          const focused = index === active;
          return <g key={`${edge.from}-${edge.to}-${index}`} className={`engine-flow-edge ${focused ? 'is-focused' : ''}`}>
            <path d={geometry.path} fill="none" stroke="currentColor" strokeWidth={focused ? 3 : 1.5} markerEnd={`url(#${markerId})`} />
            <rect x={geometry.x - 10} y={geometry.y - 10} width="20" height="20" rx="10" fill="#102234" stroke="currentColor" />
            <text x={geometry.x} y={geometry.y + 3.6} textAnchor="middle" fill="currentColor" stroke="none" fontSize="10" fontFamily="Inter" fontWeight="600">{index + 1}</text>
          </g>;
        })}
        {nodes.map(node => <foreignObject key={node.id} x={node.x} y={node.y} width={node.width} height={node.height}>
          <div xmlns="http://www.w3.org/1999/xhtml" className={`engine-flow-node ${node.id === activeEdge.from || node.id === activeEdge.to ? 'is-focused' : ''}`} data-layout-bound="true">
            <FitText text={node.label} width={node.width - 36} height={node.height - 32} maximum={24} minimum={10} lineHeight={1.15} className="engine-node-copy" />
          </div>
        </foreignObject>)}
      </svg>
      <div className="engine-flow-description" data-layout-bound="true"><span className="engine-number-badge">{ordinal(active)}</span><FitText text={currentDescription} width={BODY.width - 96} height={48} maximum={25} minimum={12} lineHeight={1.2} /></div>
    </section>
  </>;
}

export function SceneTemplate({scene, progress}) {
  switch (scene.template) {
    case 'TITLE': return <TitleScene props={scene.visualProps} progress={progress} />;
    case 'STEPS': return <CardsScene props={scene.visualProps} progress={progress} mode="STEPS" />;
    case 'STACK_QUEUE': return <StackQueueScene props={scene.visualProps} progress={progress} />;
    case 'FLOWCHART': return <FlowchartScene scene={scene} progress={progress} />;
    case 'KEY_POINTS': return <CardsScene props={scene.visualProps} progress={progress} mode="KEY_POINTS" />;
    default: throw new Error('Template is not enabled for rendering.');
  }
}
