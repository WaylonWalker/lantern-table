
export function createCharacterCanvas({mount,scene,onChange,editable=true}){
  const ns='http://www.w3.org/2000/svg';
  const el=(tag,attrs={})=>{const node=document.createElementNS(ns,tag);for(const [k,v] of Object.entries(attrs))node.setAttribute(k,String(v));return node};
  const toolbar=document.createElement('div');toolbar.className='character-canvas-toolbar';toolbar.setAttribute('role','toolbar');toolbar.setAttribute('aria-label','Drawing tools');
  const stage=document.createElement('div');stage.className='character-canvas-board';
  const svg=el('svg',{role:'img','aria-label':'Character drawing canvas'}),world=el('g');
  svg.classList.add('character-canvas-svg');
  const defs=el('defs'),mark=el('marker',{id:'lantern-arrow-tip',viewBox:'0 0 10 10',refX:9,refY:5,markerWidth:5,markerHeight:5,orient:'auto-start-reverse'});
  mark.append(el('path',{d:'M0 0 L10 5 L0 10z',fill:'#e7bd68'}));defs.append(mark);svg.append(defs,world);stage.append(svg);mount.append(toolbar,stage);
  scene.elements=Array.isArray(scene.elements)?scene.elements:[];
  const cam=scene.camera||{x:0,y:0,scale:1};scene.camera=cam;
  let tool='select',selected=null,gesture=null;
  const applyCamera=()=>world.setAttribute('transform','translate('+cam.x+' '+cam.y+') scale('+cam.scale+')');
  const coords=e=>{const r=svg.getBoundingClientRect();return{x:(e.clientX-r.left-cam.x)/cam.scale,y:(e.clientY-r.top-cam.y)/cam.scale}};
  const save=()=>onChange(scene);
  const tools=[['Select','select'],['Hand','hand'],['Text','text'],['Rectangle','rect'],['Ellipse','ellipse'],['Arrow','arrow'],['Draw','pen']];
  const buttons=[];
  for(const [label,key] of tools){const b=document.createElement('button');b.className='button compact';b.type='button';b.textContent=label;b.disabled=!editable&&key!=='hand';b.onclick=()=>{tool=key;buttons.forEach(btn=>btn.classList.toggle('active',btn.dataset.tool===tool))};b.dataset.tool=key;buttons.push(b);toolbar.append(b)}
  buttons[0].classList.add('active');
  const control=(label,action)=>{const b=document.createElement('button');b.type='button';b.className='button compact';b.textContent=label;b.onclick=action;toolbar.append(b);return b};
  control('−',()=>{cam.scale=Math.max(.25,cam.scale/1.2);applyCamera();save()});
  control('+',()=>{cam.scale=Math.min(3,cam.scale*1.2);applyCamera();save()});
  control('Center',()=>{cam.x=0;cam.y=0;cam.scale=1;applyCamera();save()});
  const del=control('Delete selected',()=>{if(!selected||!editable)return;scene.elements=scene.elements.filter(x=>x.id!==selected);selected=null;draw();save()});del.disabled=!editable;
  function draw(){
    world.replaceChildren();applyCamera();
    for(const it of scene.elements){
      let shape;const x=Number(it.x)||0,y=Number(it.y)||0,w=Number(it.w)||140,h=Number(it.h)||80;
      if(it.type==='text'){shape=el('text',{x,y,fill:'#eee8de','font-size':24});String(it.text||'').split('\n').forEach((line,i)=>{const part=el('tspan',{x,dy:i?'1.25em':0});part.textContent=line;shape.append(part)})}
      else if(it.type==='rect')shape=el('rect',{x,y,width:Math.abs(w),height:Math.abs(h),rx:9,stroke:'#e7bd68',fill:'#e7bd6819','stroke-width':2});
      else if(it.type==='ellipse')shape=el('ellipse',{cx:x+w/2,cy:y+h/2,rx:Math.abs(w/2),ry:Math.abs(h/2),stroke:'#91bce0',fill:'#91bce019','stroke-width':2});
      else if(it.type==='arrow')shape=el('path',{d:'M'+x+' '+y+' l'+w+' '+h,stroke:'#e7bd68',fill:'none','stroke-width':3,'marker-end':'url(#lantern-arrow-tip)'});
      else if(it.type==='pen')shape=el('polyline',{points:(it.points||[]).map(p=>p.join(',')).join(' '),stroke:'#e7bd68',fill:'none','stroke-width':3,'stroke-linecap':'round'});
      if(!shape)continue;
      const g=el('g',{'data-object-id':it.id});if(selected===it.id)g.classList.add('selected');g.append(shape);world.append(g);
    }
  }
  svg.addEventListener('dblclick',e=>{if(!editable)return;const id=e.target.closest('[data-object-id]')?.getAttribute('data-object-id');const item=scene.elements.find(x=>x.id===id);if(!item||item.type!=='text')return;const next=prompt('Edit text',item.text||'');if(next!==null){item.text=next;draw();save()}});
  svg.addEventListener('pointerdown',e=>{
    if(e.button!==0)return;const p=coords(e),id=e.target.closest('[data-object-id]')?.getAttribute('data-object-id'),item=scene.elements.find(x=>x.id===id);
    if(tool==='hand'||!editable){gesture={kind:'pan',clientX:e.clientX,clientY:e.clientY,cx:cam.x,cy:cam.y}}
    else if(tool==='select'&&item){selected=id;gesture={kind:'move',item,x:p.x,y:p.y,oldX:item.x,oldY:item.y,points:item.points?.map(q=>[...q])}}
    else if(tool!=='select'){const obj={id:crypto.randomUUID(),type:tool,x:p.x,y:p.y,w:140,h:80};if(tool==='text'){const text=prompt('Enter character text','');if(!text)return;obj.text=text}if(tool==='pen')obj.points=[[p.x,p.y]];scene.elements.push(obj);selected=obj.id;gesture=tool==='text'?null:{kind:'create',item:obj,x:p.x,y:p.y};save()}
    else selected=null;
    draw();if(gesture)svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener('pointermove',e=>{if(!gesture)return;
    if(gesture.kind==='pan'){cam.x=gesture.cx+e.clientX-gesture.clientX;cam.y=gesture.cy+e.clientY-gesture.clientY;applyCamera();return}
    const p=coords(e),dx=p.x-gesture.x,dy=p.y-gesture.y,it=gesture.item;
    if(gesture.kind==='move'){it.x=gesture.oldX+dx;it.y=gesture.oldY+dy;if(gesture.points)it.points=gesture.points.map(q=>[q[0]+dx,q[1]+dy])}
    else if(it.type==='pen')it.points.push([p.x,p.y]);else{it.w=dx;it.h=dy}
    draw();
  });
  const finish=()=>{if(gesture){gesture=null;save()}};svg.addEventListener('pointerup',finish);svg.addEventListener('pointercancel',finish);
  draw();
  return {destroy(){svg.replaceChildren()}};
}
