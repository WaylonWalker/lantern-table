import test from 'node:test';
import assert from 'node:assert/strict';
import {partyRevision, validateCodexProposal, previewCodexChanges, applyCodexProposal} from '../assets/living-codex.mjs';
const party = [{id:'hero',name:'Hero',class:'Wizard',level:5,spells:['Light'],features:[],inventory:[],homebrew:{name:'',notes:''}}, {id:'ally',name:'Ally',class:'Fighter',level:5,spells:[],features:[],inventory:[]}];
const campaign={id:'campaign',settings:{rules:'homebrew'}};
const revision=partyRevision(party,campaign);
const proposal={compatible:true,compatibilityReason:'Uses the current party rules and changes only this character.',operations:[{op:'add',section:'spells',value:'Honey Storm'}]};
test('proposal has no side effects before approval',()=> {
 const next=applyCodexProposal(proposal,party[0],party,campaign,revision);
 assert.deepEqual(party[0].spells,['Light']);
 assert.deepEqual(next.spells,['Light','Honey Storm']);
 assert.equal(previewCodexChanges(proposal,party[0])[0].after,'Honey Storm');
});
test('rejects stale party snapshot',()=> {
 assert.equal(validateCodexProposal(proposal,party[0],[...party,{id:'new',name:'New'}],campaign,revision).ok,false);
});
test('rejects AI claims without compatibility explanation',()=> {
 assert.equal(validateCodexProposal({...proposal,compatibilityReason:''},party[0],party,campaign,revision).ok,false);
});
test('rejects modifications to other character or protected mechanics',()=> {
 assert.equal(validateCodexProposal({...proposal,operations:[{op:'replace',section:'hp',value:'999'}]},party[0],party,campaign,revision).ok,false);
});
test('rejects illegal operations and duplicates',()=> {
 assert.equal(validateCodexProposal({...proposal,operations:[{op:'add',section:'spells',value:'Light'}]},party[0],party,campaign,revision).ok,false);
 assert.equal(validateCodexProposal({...proposal,operations:[{op:'delete',section:'spells',value:'Light'}]},party[0],party,campaign,revision).ok,false);
});
test('locked mechanics cannot be changed through AI',()=> {
 const locked={...campaign,mechanicsLockedAt:'2026-10-13'};
 const rev=partyRevision(party,locked);
 assert.equal(validateCodexProposal({...proposal,operations:[{op:'replace',section:'class',value:'Warlock'}]},party[0],party,locked,rev).ok,false);
});

test('moves existing inventory into features only after approval',()=>{
 const op={...proposal,operations:[{op:'move',from:'spells',section:'features',value:'Light'}]};
 const next=applyCodexProposal(op,party[0],party,campaign,revision);
 assert.deepEqual(next.spells,[]);
 assert.deepEqual(next.features,['Light']);
 assert.deepEqual(party[0].spells,['Light']);
});
test('edits and removes selected entries in a single reviewed transaction',()=>{
 const op={...proposal,operations:[{op:'edit',section:'spells',previous:'Light',value:'Bright Light'},{op:'remove',section:'spells',value:'Bright Light'}]};
 const next=applyCodexProposal(op,party[0],party,campaign,revision);
 assert.deepEqual(next.spells,[]);
 assert.deepEqual(party[0].spells,['Light']);
});
test('rejects impossible moves and stale source entries',()=>{
 const op={...proposal,operations:[{op:'move',from:'features',section:'spells',value:'Unknown'}]};
 assert.equal(validateCodexProposal(op,party[0],party,campaign,revision).ok,false);
});
test('does not crash when malformed AI output has no changes array',()=>{
 assert.deepEqual(previewCodexChanges({operations:null},party[0]),[]);
});
