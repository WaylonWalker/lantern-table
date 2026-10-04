// Canonical scene/location transitions. Fictional descriptions come from the DM;
// identifiers, references, timestamps, and timeline events are host-owned.
const id = kind => `${kind}_${crypto.randomUUID()}`;
const now = () => new Date().toISOString();
const clean = value => String(value ?? '').trim().slice(0, 4000);
const norm = value => String(value ?? '').trim().toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ');
const fail = reason => ({ ok:false, reason, events:[] });
function timeline(state, eventType, summary, details, at) {
  const event={id:id('evt'),at,session:state.campaign?.session||1,type:eventType,actor:'DM',actorId:null,entityId:details.entityId||null,location:details.locationName||state.scene?.location||state.scene?.title||'Unknown',summary,details,playerVisible:details.playerVisible!==false};
  state.timeline??=[];state.timeline.push(event);if(state.timeline.length>5000)state.timeline=state.timeline.slice(-5000);return event;
}
function resolveLocation(state, requestedId, name, at, playerVisible=true) {
  state.locations??=[];
  if(requestedId){const existing=state.locations.find(x=>x.id===requestedId);if(existing&&playerVisible)existing.playerVisible=true;return existing?{location:existing,created:false}:null}
  const wanted=norm(name), existing=state.locations.find(x=>[x.name,...(x.aliases||[])].some(v=>norm(v)===wanted));
  if(existing){existing.updatedAt=at;if(playerVisible)existing.playerVisible=true;return {location:existing,created:false}}
  const location={id:id('location'),name:clean(name),aliases:[],createdAt:at,updatedAt:at,playerVisible};state.locations.push(location);return {location,created:true};
}
function entitiesFor(state, ids) {
  const all=state.entities||[];const seen=new Set();
  for(const entityId of ids){if(seen.has(entityId))continue;seen.add(entityId);if(!all.some(x=>x.id===entityId))return null}
  return ids.map(entityId=>all.find(x=>x.id===entityId));
}
function setKnownLocation(entity, location, session, eventId, at) {
  entity.dmLocation={locationId:location.id,locationName:location.name,status:'known'};
  if(entity.playerVisible===false){entity.updatedAt=at;return}
  entity.currentLocation={locationId:location.id,locationName:location.name,status:'known'};
  entity.lastSeen={eventId,session,locationId:location.id,locationName:location.name};entity.updatedAt=at;
}
export function transitionScene(state, input, {at=now()}={}) {
  const title=clean(input?.title), locationName=clean(input?.location_name||input?.locationName||title), reason=clean(input?.reason);
  if(!title||!locationName||!reason)return fail('A scene transition needs a title, location name, and reason.');
  const occupantIds=Array.isArray(input.occupant_entity_ids)?input.occupant_entity_ids:[];
  const occupants=entitiesFor(state,occupantIds);if(!occupants)return fail('Scene occupants must reference known entity IDs.');
  const resolved=resolveLocation(state,input.location_id||null,locationName,at);if(!resolved)return fail('Unknown location ID; use a known location ID or null for a new/reusable location.');
  const previous=state.scene||{}, previousOccupants=new Set(previous.occupantEntityIds||[]),location=resolved.location;
  const scene={id:id('scene'),locationId:location.id,title,location:location.name,description:clean(input.description),timeOfDay:clean(input.time_of_day)||null,weather:clean(input.weather)||null,lighting:clean(input.lighting)||null,occupantEntityIds:[...new Set(occupantIds)],imageAssetId:null,enteredAt:at,updatedAt:at};
  state.scene=scene;location.updatedAt=at;
  for(const character of state.characters||[])character.location=location.name;
  const events=[];
  for(const entityId of previousOccupants){if(scene.occupantEntityIds.includes(entityId))continue;const entity=(state.entities||[]).find(x=>x.id===entityId);if(!entity||entity.playerVisible===false)continue;entity.currentLocation={locationId:previous.locationId||null,locationName:previous.location||previous.title||null,status:previous.location||previous.title?'last-known':'unknown'};entity.updatedAt=at;events.push(timeline(state,'character_departed',`${entity.name} left ${previous.title||previous.location||'the scene'}`,{entityId,sceneId:previous.id||null,locationId:previous.locationId||null,locationName:previous.location||previous.title||null},at));}
  const transition=timeline(state,'scene_transition',`The party entered ${location.name}.`,{sceneId:scene.id,locationId:location.id,fromLocationId:previous.locationId||null,toLocationId:location.id,reason,occupantEntityIds:occupants.filter(e=>e.playerVisible!==false).map(e=>e.id),createdLocation:resolved.created},at);events.push(transition);
  for(const entity of occupants){setKnownLocation(entity,location,state.campaign?.session||1,transition.id,at);if(entity.playerVisible!==false&&!previousOccupants.has(entity.id))events.push(timeline(state,'character_arrived',`${entity.name} is present at ${location.name}.`,{entityId:entity.id,sceneId:scene.id,locationId:location.id,locationName:location.name},at));}
  return {ok:true,scene,location,events};
}
export function updateScene(state,input,{at=now()}={}) {
  const scene=state.scene;if(!scene?.id||input?.scene_id!==scene.id)return fail('Scene update must reference the current scene ID.');
  const reason=clean(input.reason);if(!reason)return fail('A scene update needs a reason.');
  const add=Array.isArray(input.add_occupant_entity_ids)?input.add_occupant_entity_ids:[],remove=Array.isArray(input.remove_occupant_entity_ids)?input.remove_occupant_entity_ids:[];
  if(add.some(entityId=>remove.includes(entityId)))return fail('An entity cannot enter and leave the same scene update.');const entities=entitiesFor(state,[...add,...remove]);if(!entities)return fail('Scene occupants must reference known entity IDs.');
  const before=new Set(scene.occupantEntityIds||[]),occupants=new Set(before);for(const entityId of remove)occupants.delete(entityId);for(const entityId of add)occupants.add(entityId);
  const changed={};for(const [inputKey,stateKey] of [['description','description'],['time_of_day','timeOfDay'],['weather','weather'],['lighting','lighting']])if(input[inputKey]!=null&&scene[stateKey]!==clean(input[inputKey])){scene[stateKey]=clean(input[inputKey]);changed[stateKey]=scene[stateKey]}
  if(add.length||remove.length){scene.occupantEntityIds=[...occupants];changed.occupantEntityIds=scene.occupantEntityIds}
  if(!Object.keys(changed).length)return {ok:true,scene,events:[]};scene.updatedAt=at;
  const publicChanged={...changed};if(publicChanged.occupantEntityIds)publicChanged.occupantEntityIds=publicChanged.occupantEntityIds.filter(entityId=>state.entities.find(e=>e.id===entityId)?.playerVisible!==false);const event=timeline(state,'scene_updated',reason,{sceneId:scene.id,locationId:scene.locationId,reason,changed:publicChanged},at),events=[event];
  for(const entityId of remove){if(!before.has(entityId))continue;const entity=state.entities.find(x=>x.id===entityId);if(!entity||entity.playerVisible===false)continue;entity.dmLocation={locationId:null,locationName:null,status:'unknown'};entity.currentLocation={locationId:scene.locationId,locationName:scene.location,status:'last-known'};entity.updatedAt=at;events.push(timeline(state,'character_departed',`${entity.name} left ${scene.title}.`,{entityId,sceneId:scene.id,locationId:scene.locationId,locationName:scene.location},at));}
  for(const entityId of add){if(before.has(entityId))continue;const entity=state.entities.find(x=>x.id===entityId);if(!entity)continue;setKnownLocation(entity,{id:scene.locationId,name:scene.location},state.campaign?.session||1,event.id,at);if(entity.playerVisible!==false)events.push(timeline(state,'character_arrived',`${entity.name} entered ${scene.title}.`,{entityId,sceneId:scene.id,locationId:scene.locationId,locationName:scene.location},at));}
  return {ok:true,scene,events};
}
export function moveEntity(state,{entity_id,location_id=null,location_name='',visibility='unknown',reason=''}={},options={}) {
  const at=options.at||now(),entity=(state.entities||[]).find(x=>x.id===entity_id),why=clean(reason);
  if(!entity)return fail('Unknown entity ID.');if(!why)return fail('An entity movement needs a reason.');if(!['known','last-known','unknown'].includes(visibility))return fail('Unknown location visibility.');
  let destination=null;if(location_id||clean(location_name)){const resolved=resolveLocation(state,location_id,clean(location_name),at,visibility!=='unknown');if(!resolved)return fail('Unknown destination location ID.');destination=resolved.location}
  if(visibility!=='unknown'&&!destination)return fail('A known or last-known move needs a destination.');
  entity.dmLocation=destination?{locationId:destination.id,locationName:destination.name,status:'known'}:{locationId:null,locationName:null,status:'unknown'};
  if(entity.playerVisible!==false){if(visibility==='known'||visibility==='last-known'){entity.currentLocation={locationId:destination.id,locationName:destination.name,status:visibility};if(visibility==='known')entity.lastSeen={eventId:null,session:state.campaign?.session||1,locationId:destination.id,locationName:destination.name}}}
  entity.updatedAt=at;const shown=entity.playerVisible!==false&&visibility!=='unknown';const event=timeline(state,'character_location_changed',shown?`${entity.name} moved to ${destination.name}.`:`${entity.name}'s location changed outside the party's knowledge.`,{entityId:entity.id,visibility,...(shown?{locationId:destination.id,locationName:destination.name}:{}),reason,...(!shown?{playerVisible:false}:{})},at);
  if(shown&&visibility==='known')entity.lastSeen.eventId=event.id;return {ok:true,entity,events:[event]};
}
export function setEntityKnownLocation(state,{entity_id,location_id=null,location_name='',visibility='unknown',reason=''}={},options={}) {
  const at=options.at||now(),entity=(state.entities||[]).find(x=>x.id===entity_id),why=clean(reason);
  if(!entity)return fail('Unknown entity ID.');if(!why)return fail('A location knowledge update needs a reason.');if(!['known','last-known','unknown'].includes(visibility))return fail('Unknown location visibility.');
  let destination=null;if(location_id||clean(location_name)){const resolved=resolveLocation(state,location_id,clean(location_name),at,visibility!=='unknown');if(!resolved)return fail('Unknown location ID.');destination=resolved.location}
  if(visibility!=='unknown'&&!destination)return fail('A known or last-known location needs a destination.');
  if(entity.playerVisible!==false){entity.currentLocation=visibility==='unknown'?{locationId:null,locationName:null,status:'unknown'}:{locationId:destination.id,locationName:destination.name,status:visibility};if(visibility==='known')entity.lastSeen={eventId:null,session:state.campaign?.session||1,locationId:destination.id,locationName:destination.name}}
  entity.updatedAt=at;const shown=entity.playerVisible!==false&&visibility!=='unknown',event=timeline(state,'character_location_changed',shown?`${entity.name}'s ${visibility} location was updated.`:`${entity.name}'s location knowledge changed.`,{entityId:entity.id,visibility,...(shown?{locationId:destination.id,locationName:destination.name}:{}),reason,...(!shown?{playerVisible:false}:{})},at);if(shown&&visibility==='known')entity.lastSeen.eventId=event.id;return {ok:true,entity,events:[event]};
}
export function setEntityRelationship(state,{entity_id,relationship,reason=''}={},options={}) {
  const at=options.at||now(),entity=(state.entities||[]).find(x=>x.id===entity_id),value=clean(relationship),why=clean(reason);if(!entity)return fail('Unknown entity ID.');if(!value||!why)return fail('A relationship update needs a value and reason.');const before=entity.relationship||'Unknown';entity.relationship=value;entity.updatedAt=at;const event=timeline(state,'character_relationship_changed',`${entity.name}'s relationship to the party changed.`,{entityId,from:before,to:value,reason:why},at);return {ok:true,entity,events:[event]};
}
export function scenePromptContext(state,{playerSafe=false}={}){const scene=state.scene||{},visibleEntities=(state.entities||[]).filter(e=>(scene.occupantEntityIds||[]).includes(e.id)&&(!playerSafe||e.playerVisible!==false)),entities=visibleEntities.map(e=>({id:e.id,name:e.name,short_description:e.shortDescription||''}));return {scene_id:scene.id||null,location_id:scene.locationId||null,title:scene.title||'',location:scene.location||'',description:scene.description??scene.text??'',time_of_day:scene.timeOfDay??null,weather:scene.weather??null,lighting:scene.lighting??null,occupant_entity_ids:visibleEntities.map(e=>e.id),occupant_entities:entities};}
export function relevantEntityContext(state,limit=40){const score=new Map(),add=(entityId,n)=>score.set(entityId,(score.get(entityId)||0)+n);for(const c of state.characters||[])add(c.entityId||c.id,100);for(const entityId of state.scene?.occupantEntityIds||[])add(entityId,80);for(const q of state.quests||[])for(const entityId of q.entityIds||[])add(entityId,50);for(const e of (state.timeline||[]).slice(-40))if(e.entityId)add(e.entityId,10);return [...score.entries()].sort((a,b)=>b[1]-a[1]).slice(0,limit).map(([entityId])=>(state.entities||[]).find(e=>e.id===entityId)).filter(e=>e&&e.playerVisible!==false).map(e=>({id:e.id,kind:e.kind,name:e.name,aliases:e.aliases||[],shortDescription:e.shortDescription||'',relationship:e.relationship||'Unknown',currentLocation:e.currentLocation||{status:'unknown'},dmLocation:e.dmLocation||{status:'unknown'}}));}
export function playerSafeProjection(value){if(Array.isArray(value))return value.filter(item=>!(item&&typeof item==='object'&&item.playerVisible===false)).map(playerSafeProjection);if(!value||typeof value!=='object')return value;if(value.scene&&Array.isArray(value.entities)){const visibleIds=new Set(value.entities.filter(e=>e.playerVisible!==false).map(e=>e.id));value={...value,scene:{...value.scene,occupantEntityIds:(value.scene.occupantEntityIds||[]).filter(id=>visibleIds.has(id))}};}const out={};for(const [key,item] of Object.entries(value)){if(/^(dm|gm|hidden|secret|private)/i.test(key)||key==='playerVisible')continue;if(item&&typeof item==='object'&&item.playerVisible===false)continue;out[key]=playerSafeProjection(item)}return out;}
