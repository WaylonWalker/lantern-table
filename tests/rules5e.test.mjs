import test from 'node:test';
import assert from 'node:assert/strict';
import * as rules from '../assets/rules5e.mjs';

const actor=(id,extra={})=>({id,entityId:id,name:id,ownerPlayerId:id==='a'?'p':null,mechanicsReady:true,hp:10,maxHp:10,ac:12,speed:30,position:{x:id==='a'?0:1,y:0},abilities:{str:14,dex:16,con:10},skills:{stealth:true},saves:{str:false,dex:false,con:false,int:false,wis:false,cha:false},proficiencyBonus:2,...extra});
const fixture=()=>({characters:[actor('a'),actor('b',{ownerPlayerId:null})],game:{phase:'freeplay'},timeline:[]});
const fixed=(...values)=>sides=>{const value=values.shift()??10;assert.ok(value>=1&&value<=sides);return value};

test('freeplay has no initiative lock and combat start uses stable initiative order',()=>{
  const state=fixture();assert.equal(state.game.phase,'freeplay');
  const result=rules.beginCombat(state,{roller:fixed(12,8)});assert.equal(result.ok,true);assert.equal(state.game.phase,'combat');
  assert.deepEqual(result.events.filter(x=>['turn_started','death_save'].includes(x.eventType)).map(x=>x.eventType),['turn_started']);
  const order=state.combat.order.map(x=>x.entityId);rules.startNextRoundTurn(state,{now:state.combat.turnStartedAt+1});rules.startNextRoundTurn(state,{now:state.combat.turnStartedAt+1});assert.equal(state.combat.round,2);assert.deepEqual(state.combat.order.map(x=>x.entityId),order);
});
test('turn actions require active actor and current turn id; reactions can be used only once',()=>{
  const s=fixture();rules.beginCombat(s,{roller:fixed(12,8)});const active=s.combat.order[0],other=s.combat.order[1];
  assert.equal(rules.validateIntent(s,{actorId:other.entityId,intent:{kind:'action',action:'Dodge'},turnId:s.combat.turnId}).ok,false);
  assert.match(rules.validateIntent(s,{actorId:active.entityId,intent:{kind:'action',action:'Dodge'},turnId:'old'}).reason,/Stale/);
  assert.equal(rules.validateIntent(s,{actorId:other.entityId,intent:{kind:'reaction',trigger:'opportunity_attack'},turnId:s.combat.turnId}).ok,true);
  assert.equal(rules.validateIntent(s,{actorId:other.entityId,intent:{kind:'reaction',trigger:'opportunity_attack'},turnId:s.combat.turnId}).ok,false);
});
test('surprise is individual and ends after that creature first turn',()=>{
  const s=fixture();rules.beginCombat(s,{surprise:{b:true},roller:fixed(12,8)});const b=s.combat.order.find(x=>x.entityId==='b');
  s.combat.activeIndex=s.combat.order.indexOf(b);s.combat.turnId='bturn';
  assert.equal(rules.validateIntent(s,{actorId:'b',turnId:'bturn',intent:{kind:'move',feet:1}}).ok,false);
  const first=rules.endTurn(s);assert.equal(first.ok,true);assert.equal(b.firstTurn,false);assert.equal('surpriseRound' in s.combat,false);
});
test('movement splits against budget, action is single, Delay is rejected, Ready spends action',()=>{
  const s=fixture();rules.beginCombat(s,{roller:fixed(12,8)});const a=s.combat.order[0].entityId;
  assert.equal(rules.validateIntent(s,{actorId:a,turnId:s.combat.turnId,intent:{kind:'move',to:{x:2,y:0}}}).events[0].outcome.feet,10);
  assert.equal(rules.validateIntent(s,{actorId:a,turnId:s.combat.turnId,intent:{kind:'action',action:'Dodge'}}).ok,true);
  assert.equal(rules.validateIntent(s,{actorId:a,turnId:s.combat.turnId,intent:{kind:'move',to:{x:6,y:0}}}).events[0].outcome.feet,20);
  assert.equal(rules.validateIntent(s,{actorId:a,turnId:s.combat.turnId,intent:{kind:'move',to:{x:7,y:0}}}).ok,false);
  assert.equal(rules.validateIntent(s,{actorId:a,turnId:s.combat.turnId,intent:{kind:'bonus_action',action:'extra attack'}}).ok,false);
  assert.equal(rules.validateIntent(s,{actorId:a,turnId:s.combat.turnId,intent:{kind:'action',action:'Dash'}}).ok,false);
  const t=fixture();rules.beginCombat(t,{roller:fixed(12,8)});const id=t.combat.order[0].entityId;
  assert.match(rules.validateIntent(t,{actorId:id,turnId:t.combat.turnId,intent:{kind:'action',action:'Delay'}}).reason,/no Delay/);
  assert.equal(rules.validateIntent(t,{actorId:id,turnId:t.combat.turnId,intent:{kind:'action',action:'Ready',trigger:'when the door opens',response:'Attack'}}).ok,false);
});
test('checks derive modifiers and advantage rolls are auditable',()=>{
  const s=fixture();s.characters[0].effects=[{kind:'ability_check',skill:'stealth',advantage:true,reason:'Help action'}];const r=rules.validateIntent(s,{actorId:'a',roller:fixed(4,17),intent:{kind:'ability_check',ability:'dex',skill:'stealth',dc:15}});
  assert.equal(r.roll.total,22);assert.deepEqual(r.roll.dice,[4,17]);assert.deepEqual(r.roll.modifiers,[3,2]);assert.deepEqual(r.roll.advantageReasons,['Help action']);assert.equal(r.result.success,true);
});
test('attacks honor range, natural 1 and 20, AC and apply damage only on hit',()=>{
  const s=fixture();rules.beginCombat(s,{roller:fixed(12,8)});const a=s.combat.order[0].entityId;s.combat.turnLocal.actionAvailable=true;
  s.combat.order.find(x=>x.entityId==='b').position={x:8,y:0};assert.equal(rules.validateIntent(s,{actorId:a,turnId:s.combat.turnId,roller:fixed(10),intent:{kind:'action',action:'Attack',targetId:'b',weapon:'unarmed'}}).ok,false);
  s.combat.order.find(x=>x.entityId==='b').position={x:1,y:0};let result=rules.validateIntent(s,{actorId:a,turnId:s.combat.turnId,roller:fixed(1),intent:{kind:'action',action:'Attack',targetId:'b',weapon:'unarmed'}});assert.equal(result.result.hit,false);assert.equal(s.characters[1].hp,10);
  s.combat.turnLocal.actionAvailable=true;result=rules.validateIntent(s,{actorId:a,turnId:s.combat.turnId,roller:fixed(20),intent:{kind:'action',action:'Attack',targetId:'b',weapon:'unarmed'}});assert.equal(result.result.critical,true);assert.equal(s.characters[1].hp,7);
});
test('surprise blocks action, incapacitation blocks action, timeout Dodges legally',()=>{
  const s=fixture();rules.beginCombat(s,{roller:fixed(12,8)});s.combat.turnDeadlineAt=0;const out=rules.handleTurnTimeout(s,{now:100,roller:fixed(10)});assert.equal(out.ok,true);assert.ok(out.events.some(x=>x.eventType==='turn_timed_out'&&x.sourceRule==='lantern:procedure:turn-timeout'));assert.ok(out.events.some(x=>x.eventType==='action_dodge'));
  const t=fixture();t.characters[0].conditions=['incapacitated'];rules.beginCombat(t,{roller:fixed(12,8)});t.combat.turnDeadlineAt=0;const event=rules.handleTurnTimeout(t,{now:100});assert.equal(event.events.some(x=>x.eventType==='action_dodge'),false);
});
test('death saves are mandatory and stable characters stop rolling',()=>{
  const s=fixture();s.characters[0].hp=0;s.characters[0].deathSaves={successes:0,failures:0,stable:false};
  const first=rules.resolveStartTurn(s,s.characters[0],fixed(10));assert.equal(first[0].outcome.successes,1);
  s.characters[0].deathSaves={successes:2,failures:0,stable:false};const third=rules.resolveStartTurn(s,s.characters[0],fixed(10));assert.equal(third[0].outcome.stable,true);
  assert.equal(rules.resolveStartTurn(s,s.characters[0],fixed(1)).length,0);
  s.characters[1].hp=0;s.characters[1].deathSaves={successes:0,failures:0,stable:false};const one=rules.resolveStartTurn(s,s.characters[1],fixed(1));assert.equal(one[0].outcome.failures,2);
  const nat20=rules.resolveStartTurn(s,s.characters[1],fixed(20));assert.equal(s.characters[1].hp,1);
  assert.equal(rules.abilityModifier(16),3);assert.equal(rules.abilityModifier(9),-1);
});
test('saving throws derive save proficiency from the actual character and unconscious saves fail automatically',()=>{
  const s=fixture();s.characters[0].saves.dex=true;
  const save=rules.resolveSavingThrow(s,{actorId:'a',ability:'dex',dc:15,sourceRule:'srd5.1:saving-throw',sourceFeature:'trap_1',roller:fixed(10)});
  assert.equal(save.events[0].roll.total,15);assert.deepEqual(save.events[0].roll.modifiers,[3,2]);assert.equal(save.result.success,true);
  s.characters[0].conditions=['unconscious'];const auto=rules.resolveSavingThrow(s,{actorId:'a',ability:'dex',dc:10,sourceRule:'srd5.1:saving-throw',sourceFeature:'trap_1',roller:fixed(19)});
  assert.equal(auto.result.success,false);assert.equal(auto.result.automaticFailure,true);assert.equal(auto.events[0].roll,null);
});
test('Dodge, Dash and Disengage use turn-local state and table reactions default to decline',()=>{
  const s=fixture();rules.beginCombat(s,{roller:fixed(12,8)});const a=s.combat.order[0].entityId;
  assert.equal(rules.validateIntent(s,{actorId:a,turnId:s.combat.turnId,intent:{kind:'action',action:'Dash'}}).ok,true);assert.equal(s.combat.turnLocal.movementRemaining,60);
  const declined=rules.dismissOptionalReaction(s,'a');assert.equal(declined.events[0].eventType,'reaction_declined');assert.equal(declined.events[0].sourceRule,'lantern:procedure:reaction-timeout');
});
test('opportunity attack trigger ignores forced movement, teleport, Disengage and unseen movers',()=>{
  const attacker=actor('a'),mover=actor('b');
  const base={attacker,mover,distanceBefore:5,distanceAfter:10};assert.equal(rules.opportunityAttackTrigger(base),true);
  assert.equal(rules.opportunityAttackTrigger({...base,movement:'forced'}),false);
  assert.equal(rules.opportunityAttackTrigger({...base,movement:'teleport'}),false);
  assert.equal(rules.opportunityAttackTrigger({...base,disengaged:true}),false);
  assert.equal(rules.opportunityAttackTrigger({...base,canSee:false}),false);
});

test('reaction remains spent through other turns and resets only at its owners next turn',()=>{
  const s={characters:[actor('a',{abilities:{str:14,dex:18,con:10}}),actor('b',{ownerPlayerId:null,abilities:{str:14,dex:14,con:10}}),actor('c',{ownerPlayerId:null,abilities:{str:14,dex:10,con:10}})],game:{phase:'freeplay'}};
  rules.beginCombat(s,{roller:fixed(10,10,10)});
  const a=s.combat.order.find(x=>x.entityId==='a');
  // Move to B's turn, use A's off-turn reaction, then advance through C.
  s.combat.activeIndex=s.combat.order.findIndex(x=>x.entityId==='b');s.combat.turnId='b-turn';
  assert.equal(rules.validateIntent(s,{actorId:'a',turnId:'b-turn',intent:{kind:'reaction',trigger:'opportunity_attack'}}).ok,true);
  assert.equal(a.reactionAvailable,false);
  const cIndex=s.combat.order.findIndex(x=>x.entityId==='c');s.combat.activeIndex=cIndex;s.combat.turnId='c-turn';
  assert.equal(a.reactionAvailable,false);
  rules.startNextRoundTurn(s,{now:10}); // C's turn ends; A's starts and resets its reaction.
  assert.equal(a.reactionAvailable,true);
});

test('plain incapacitated creatures may move; conditions that prevent movement may not',()=>{
  for(const condition of ['incapacitated','unconscious','stunned','paralyzed']){
    const s=fixture();s.characters[0].conditions=[condition];rules.beginCombat(s,{roller:fixed(12,8)});
    const entry=s.combat.order.find(x=>x.entityId==='a');s.combat.activeIndex=s.combat.order.indexOf(entry);s.combat.turnId='condition-turn';
    const moving=rules.validateIntent(s,{actorId:'a',turnId:'condition-turn',intent:{kind:'move',to:{x:1,y:0}}});
    assert.equal(moving.ok,condition==='incapacitated',condition);
    assert.equal(rules.turnRequiresNoChoice(s),['unconscious','stunned','paralyzed'].includes(condition),condition);
  }
});

test('initiative start and fast-forward preserve per-creature surprise turn events',()=>{
  const s=fixture();const started=rules.beginCombat(s,{surprise:{a:true},roller:fixed(12,8)});
  const events=[...started.events];
  if(rules.turnRequiresNoChoice(s))events.push(...rules.endTurn(s).events);
  assert.equal(events.filter(x=>x.eventType==='turn_started').length>=2,true);
  assert.equal(events.some(x=>x.eventType==='turn_ended'&&x.actorId==='a'),true);
  assert.equal(s.combat.order.find(x=>x.entityId==='a').firstTurn,false);
  assert.equal(s.combat.order.find(x=>x.entityId==='a').reactionAvailable,true);
});

test('critical attacks double damage dice but never the ability modifier',()=>{
  const s=fixture();rules.beginCombat(s,{roller:fixed(12,8)});const a=s.combat.order[0].entityId;
  const target=s.combat.order.find(x=>x.entityId==='b');target.position={x:1,y:0};s.combat.turnLocal.actionAvailable=true;
  const result=rules.validateIntent(s,{actorId:a,turnId:s.combat.turnId,roller:fixed(20,4,5),intent:{kind:'action',action:'Attack',targetId:'b',weapon:'shortsword'}});
  assert.equal(result.result.damage,12); // 4 + 5 + STR modifier 3
  assert.deepEqual(result.events[0].damageRoll.dice,[4,5]);
  assert.deepEqual(result.events[0].damageRoll.modifiers,[3]);
});

test('party and DM absent-control permissions are independent and require offline ownership',()=>{
 const base={requesterRole:'player',requesterId:'delegate',ownerId:'absent',ownerOnline:false};
 for(const party of [false,true])for(const dm of [false,true]){
  const permissions={partyControlAbsent:party,dmControlAbsent:dm};
  assert.equal(rules.canControlCombatant({...base,permissions}),party,`party permission ${party}, dm permission ${dm}`);
  assert.equal(rules.canControlCombatant({...base,requesterRole:'host',permissions}),dm,`host DM permission ${dm}, party permission ${party}`);
 }
 assert.equal(rules.canControlCombatant({...base,ownerOnline:true,permissions:{partyControlAbsent:true}}),false);
 assert.equal(rules.canControlCombatant({...base,requesterId:'absent',ownerOnline:true,permissions:{}}),true);
 assert.equal(rules.canControlCombatant({...base,ownerId:null,permissions:{partyControlAbsent:true}}),false);
 assert.equal(rules.canControlCombatant({...base,requesterRole:'host',ownerId:null,permissions:{}}),true);
});
