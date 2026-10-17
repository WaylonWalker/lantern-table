// Adaptive Sheet 2.0: isolated, opt-in homebrew workspace.
// Never mutates the existing 5e character or campaign snapshot.
const KEY = 'lantern.adaptive-sheet.v1';
const clone = value => JSON.parse(JSON.stringify(value));
export const emptySheet = () => ({version:1, status:'draft', sections:[], history:[]});
export function parseSheet(raw) {
  let value = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!value || typeof value !== 'object' || value.version !== 1 || !Array.isArray(value.sections)) throw Error('Unsupported adaptive sheet');
  if (value.sections.length > 150) throw Error('Too many sections');
  const ids = new Set();
  const sections = value.sections.map(section => {
    if (!section || typeof section !== 'object' || !Array.isArray(section.fields)) throw Error('Invalid section');
    const id = String(section.id || '');
    if (!id || ids.has(id)) throw Error('Duplicate or missing section id');
    ids.add(id);
    if (section.fields.length > 150) throw Error('Too many fields');
    const fieldIds = new Set();
    return {id, title:String(section.title || 'Untitled').slice(0,120), fields:section.fields.map(field => {
      const id = String(field?.id || '');
      if (!id || fieldIds.has(id)) throw Error('Duplicate or missing field id');
      fieldIds.add(id);
      return {id,label:String(field.label || 'Stat').slice(0,120),value:String(field.value ?? '').slice(0,10000)};
    })};
  });
  return {version:1,status:value.status === 'approved' ? 'approved':'draft',sections,history:Array.isArray(value.history)?value.history.slice(-20):[]};
}
export function installAdaptiveSheet() {
  const host = document.querySelector('#view-character .character-card');
  if (!host || host.querySelector('#adaptiveSheet')) return;
  const root = document.createElement('section');
  root.id='adaptiveSheet';
  root.className='adaptive-sheet';
  root.innerHTML=`<details><summary>🧬 Character Sheet 2.0 · Unrestricted homebrew</summary>
  <p class="muted">Create any stat, rule, or section. This is a local draft workspace; it does not change the active 5e rules engine or synchronize with the party.</p>
  <div class="adaptive-actions">
    <button type="button" data-action="add-section" class="button compact">+ Section</button>
    <button type="button" data-action="layout" class="button compact">Reorder sections</button>
    <button type="button" data-action="approve" class="button compact">Approve draft locally</button>
    <button type="button" data-action="export" class="button compact">Export JSON</button>
    <label class="button compact">Import JSON<input type="file" accept=".json,application/json" data-action="import" hidden></label>
  </div><p class="small-note" id="adaptiveStatus" role="status"></p><div id="adaptiveSections"></div>
  </details>`;
  host.append(root);
  const sectionsEl=root.querySelector('#adaptiveSections');
  const statusEl=root.querySelector('#adaptiveStatus');
  let sheet;
  try {sheet=parseSheet(localStorage.getItem(KEY)||emptySheet());}
  catch {sheet=emptySheet(); statusEl.textContent='Could not load saved draft; starting a new workspace.';}
  let layout=false;
  const uid=()=>crypto.randomUUID();
  const safe=(text)=>String(text).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const persist=()=>{localStorage.setItem(KEY,JSON.stringify(sheet));statusEl.textContent=sheet.status==='approved'?'Locally approved (not activated in campaign)':'Draft saved locally';};
  const dirty=()=>{if(sheet.status==='approved')sheet.status='draft';persist();};
  const render=()=>{
    sectionsEl.replaceChildren();
    for (const section of sheet.sections) {
      const card=document.createElement('article');
      card.className='adaptive-section panel-card';
      card.dataset.section=section.id;
      card.draggable=layout;
      card.innerHTML=`<div class="adaptive-heading"><input aria-label="Section name" data-section-title="${safe(section.id)}" value="${safe(section.title)}"><button type="button" data-add-field="${safe(section.id)}" class="button compact">+ Field</button><button type="button" data-remove-section="${safe(section.id)}" class="button compact">Remove</button></div><div class="adaptive-fields"></div>`;
      const fields=card.querySelector('.adaptive-fields');
      for (const field of section.fields) {
        const row=document.createElement('div');
        row.className='adaptive-field';
        row.innerHTML=`<input aria-label="Field label" data-field-label="${safe(field.id)}" value="${safe(field.label)}"><textarea aria-label="Field value or rule" rows="2" data-field-value="${safe(field.id)}">${safe(field.value)}</textarea><button type="button" class="button compact" data-remove-field="${safe(field.id)}">×</button>`;
        fields.append(row);
      }
      sectionsEl.append(card);
    }
  };
  root.addEventListener('input',e=>{
    const el=e.target, section=el.closest('[data-section]'), data=sheet.sections.find(x=>x.id===section?.dataset.section);
    if(!data)return;
    if(el.matches('[data-section-title]'))data.title=el.value;
    const field=data.fields.find(f=>f.id===(el.dataset.fieldLabel||el.dataset.fieldValue));
    if(field){if(el.hasAttribute('data-field-label'))field.label=el.value;else field.value=el.value;}
    dirty();
  });
  root.addEventListener('click',e=>{
    const button=e.target.closest('button');if(!button)return;
    const action=button.dataset.action;
    if(action==='add-section')sheet.sections.push({id:uid(),title:'New section',fields:[]});
    if(action==='layout'){layout=!layout;button.setAttribute('aria-pressed',String(layout));button.textContent=layout?'Done reordering':'Reorder sections';}
    if(action==='approve'){sheet.history.push({at:new Date().toISOString(),snapshot:clone(sheet.sections)});sheet.history=sheet.history.slice(-20);sheet.status='approved';}
    if(action==='export'){const blob=new Blob([JSON.stringify(sheet,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='lantern-adaptive-sheet.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
    const section=sheet.sections.find(s=>s.id===(button.dataset.addField||button.dataset.removeSection||button.closest('[data-section]')?.dataset.section));
    if(button.dataset.addField && section)section.fields.push({id:uid(),label:'New stat',value:''});
    if(button.dataset.removeField && section)section.fields=section.fields.filter(f=>f.id!==button.dataset.removeField);
    if(button.dataset.removeSection)sheet.sections=sheet.sections.filter(s=>s.id!==button.dataset.removeSection);
    if(action!=='export'&&action!=='layout'){dirty();if(action==='approve'){sheet.status='approved';persist();}render();}
    if(action==='layout')render();
  });
  root.querySelector('[data-action="import"]').addEventListener('change',async e=>{
    const file=e.target.files?.[0];if(!file)return;
    try {if(file.size>2000000)throw Error('File too large');const imported=parseSheet(await file.text());sheet={...imported,status:'draft'};persist();render();}
    catch(error){statusEl.textContent='Import rejected: '+error.message;}
    e.target.value='';
  });
  let dragged=null;
  sectionsEl.addEventListener('dragstart',e=>{if(layout)dragged=e.target.closest('[data-section]')?.dataset.section;});
  sectionsEl.addEventListener('dragover',e=>{if(layout&&e.target.closest('[data-section]'))e.preventDefault();});
  sectionsEl.addEventListener('drop',e=>{
    if(!layout||!dragged)return;e.preventDefault();
    const target=e.target.closest('[data-section]')?.dataset.section;
    const from=sheet.sections.findIndex(s=>s.id===dragged),to=sheet.sections.findIndex(s=>s.id===target);
    if(from>=0&&to>=0&&from!==to){sheet.sections.splice(to,0,sheet.sections.splice(from,1)[0]);dirty();render();}
    dragged=null;
  });
  render();
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',installAdaptiveSheet,{once:true});else installAdaptiveSheet();
