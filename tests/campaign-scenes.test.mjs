import test from 'node:test';
import assert from 'node:assert/strict';
import * as scenes from '../assets/campaign-scenes.mjs';
const stateFixture=()=>({campaign:{session:3},scene:{id:'scene_study',locationId:'location_study',title:'Study',location:'Old Study',description:'A book-lined room.',occupantEntityIds:[],text:'A book-lined room.'},locations:[{id:'location_study',name:'Old Study',aliases:['Study'],createdAt:'2026-01-01',updatedAt:'2026-01-01'}],characters:[{id:'pc1',entityId:'pc1',location:'Old Study'}],entities:[{id:'npc_b',kind:'npc',name:'Branna',playerVisible:true,currentLocation:{locationId:'location_study',locationName:'Old Study',status:'known'}},{id:'npc_v',kind:'villain',name:'The Ash Duke',playerVisible:true,dmLocation:{locationName:'Crypt'},currentLocation:{locationId:'location_docks',locationName:'Docks',status:'last-known'}}],timeline:[],quests:[]});
const at='2026-10-03T12:00:00.000Z';

test('a transition creates a stable scene/location identity and a timeline event',()=>{
 const s=stateFixture(),r=scenes.transitionScene(s,{location_id:null,title:'Flooded Crypt',location_name:'Crypt Beneath Saint Orra',description:'Black water covers the floor.',time_of_day:'night',weather:'storm outside',lighting:'blue witchlight',occupant_entity_ids:[],reason:'The party descends.'},{at});
 assert.equal(r.ok,true);assert.match(s.scene.id,/^scene_/);assert.match(s.scene.locationId,/^location_/);assert.equal(s.scene.location,'Crypt Beneath Saint Orra');assert.equal(s.characters[0].location,s.scene.location);assert.equal(s.timeline.filter(e=>e.type==='scene_transition').length,1);assert.equal(s.timeline[0].details.reason,'The party descends.');
});
test('returning by known location ID or alias reuses location while creating a fresh scene',()=>{
 const s=stateFixture();const first=s.scene.id;
 const returned=scenes.transitionScene(s,{location_id:null,title:'Study again',location_name:'Study',description:'Dusty books.',occupant_entity_ids:[],reason:'The party returns.'},{at});
 assert.equal(returned.ok,true);assert.equal(s.scene.locationId,'location_study');assert.notEqual(s.scene.id,first);assert.equal(s.locations.length,1);
});
test('ordinary no-tool interaction leaves canonical scene identity unchanged',()=>{
 const s=stateFixture(),before=structuredClone(s.scene); // searching and talking need no scene tool
 assert.deepEqual(s.scene,before);assert.equal(s.timeline.some(e=>e.type==='scene_transition'||e.type==='scene_updated'),false);
});
test('update_scene changes facts without replacing scene identity',()=>{
 const s=stateFixture(),id=s.scene.id,r=scenes.updateScene(s,{scene_id:id,description:'Rain rattles the windows.',time_of_day:'night',weather:'heavy rain',lighting:null,add_occupant_entity_ids:[],remove_occupant_entity_ids:[],reason:'Two hours pass and rain begins.'},{at});
 assert.equal(r.ok,true);assert.equal(s.scene.id,id);assert.equal(s.scene.description,'Rain rattles the windows.');assert.equal(s.scene.timeOfDay,'night');assert.equal(s.scene.weather,'heavy rain');assert.equal(s.timeline[0].type,'scene_updated');
});
test('NPC arrival/departure synchronizes occupants and visible last-known location',()=>{
 const s=stateFixture();let r=scenes.transitionScene(s,{location_id:null,title:'Workshop',location_name:'Workshop',description:'Tools cover the benches.',time_of_day:null,weather:null,lighting:null,occupant_entity_ids:[],reason:'The party enters the workshop.'},{at});
 assert.equal(r.ok,true);r=scenes.updateScene(s,{scene_id:s.scene.id,description:null,time_of_day:null,weather:null,lighting:null,add_occupant_entity_ids:['npc_b'],remove_occupant_entity_ids:[],reason:'Branna enters with a broken arm.'},{at});assert.equal(r.ok,true);assert.deepEqual(s.scene.occupantEntityIds,['npc_b']);assert.equal(s.entities[0].currentLocation.status,'known');assert.equal(s.entities[0].lastSeen.locationId,s.scene.locationId);
 r=scenes.updateScene(s,{scene_id:s.scene.id,description:null,time_of_day:null,weather:null,lighting:null,add_occupant_entity_ids:[],remove_occupant_entity_ids:['npc_b'],reason:'Branna leaves.'},{at});
 assert.equal(r.ok,true);assert.deepEqual(s.scene.occupantEntityIds,[]);assert.equal(s.entities[0].currentLocation.status,'last-known');assert.equal(s.entities[0].currentLocation.locationName,'Workshop');
});
test('hidden entity movement preserves last-known player location without exposing its destination',()=>{
 const s=stateFixture(),before=s.entities[1].currentLocation;
 const r=scenes.moveEntity(s,{entity_id:'npc_v',location_id:null,location_name:'Black Crypt',visibility:'unknown',reason:'The Ash Duke escaped unseen.'},{at});
 assert.equal(r.ok,true);assert.deepEqual(s.entities[1].currentLocation,before);assert.equal(s.entities[1].dmLocation.locationName,'Black Crypt');
 const safe=scenes.playerSafeProjection(s);assert.equal(safe.locations.some(l=>l.name==='Black Crypt'),false);assert.equal(safe.entities.find(e=>e.id==='npc_v').dmLocation,undefined);assert.equal(safe.timeline.some(e=>e.details?.locationName==='Black Crypt'),false);
});
test('hidden scene occupants are omitted from player scene and timeline references',()=>{
 const s=stateFixture();s.entities.push({id:'hidden_watch',name:'Unseen watcher',playerVisible:false});
 const r=scenes.transitionScene(s,{location_id:null,title:'Chapel',location_name:'Chapel',description:'Quiet stone.',time_of_day:null,weather:null,lighting:null,occupant_entity_ids:['hidden_watch'],reason:'The party enters.'},{at});assert.equal(r.ok,true);
 const safe=scenes.playerSafeProjection(s);assert.deepEqual(safe.scene.occupantEntityIds,[]);assert.equal(safe.timeline.some(e=>JSON.stringify(e).includes('hidden_watch')),false);
});
test('unknown location or occupant IDs are rejected without changing state',()=>{
 const s=stateFixture(),before=structuredClone(s.scene);let r=scenes.transitionScene(s,{location_id:'location_missing',title:'Unknown',location_name:'Unknown',description:'',occupant_entity_ids:[],reason:'Bad ref.'},{at});assert.equal(r.ok,false);assert.deepEqual(s.scene,before);
 r=scenes.updateScene(s,{scene_id:s.scene.id,description:null,time_of_day:null,weather:null,lighting:null,add_occupant_entity_ids:['missing'],remove_occupant_entity_ids:[],reason:'Bad occupant.'},{at});assert.equal(r.ok,false);assert.deepEqual(s.scene,before);
});
test('player-safe projection strips nested hidden data and invisible entities from all state sections',()=>{
 const s=stateFixture();s.entities.push({id:'hidden_npc',kind:'villain',name:'Hidden villain',playerVisible:false,dmLocation:{locationName:'Crypt'}});s.scene.occupantEntityIds=['npc_b','hidden_npc'];s.cards=[{title:'Public',detail:{dmNotes:'secret',text:'visible'}},{title:'Hidden',playerVisible:false}];s.messages=[{text:'hello',toolPayload:{privateValue:'secret',safe:'yes'}}];
 const safe=scenes.playerSafeProjection(s);assert.equal(safe.entities.length,2);assert.equal(safe.entities.some(e=>e.dmLocation),false);assert.equal(safe.entities.some(e=>e.id==='hidden_npc'),false);assert.deepEqual(safe.scene.occupantEntityIds,['npc_b']);assert.deepEqual(safe.cards,[{title:'Public',detail:{text:'visible'}}]);assert.deepEqual(safe.messages,[{text:'hello',toolPayload:{safe:'yes'}}]);assert.equal(s.entities[1].dmLocation.locationName,'Crypt');
});
test('DM context carries the current scene and bounded stable-ID entity references',()=>{
 const s=stateFixture();s.scene.occupantEntityIds=['npc_b'];s.entities.push({id:'pc1',kind:'pc',name:'Hero',playerVisible:true},...Array.from({length:100},(_,i)=>({id:`n${i}`,name:`Named ${i}`,playerVisible:true})));const scene=scenes.scenePromptContext(s),known=scenes.relevantEntityContext(s,40);assert.equal(scene.scene_id,'scene_study');assert.equal(scene.location_id,'location_study');assert.equal(known.length,2);assert.ok(known.some(e=>e.id==='pc1'));
});
