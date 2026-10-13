// AI homebrew is a proposed diff, not a mutation. Only explicitly approved diffs can save.
const ARRAYS = new Set(['inventory', 'spells', 'features']);
const HOMEBREW_FIELDS = new Set(['name', 'description', 'traits', 'abilities', 'notes']);
const IDENTITY_FIELDS = new Set(['species', 'class', 'subclass', 'background']);
const clone = value => JSON.parse(JSON.stringify(value));
const indexOfText = (values, value) => values.findIndex(x => typeof x === 'string' && x.toLocaleLowerCase() === value.trim().toLocaleLowerCase());
export function partyRevision(characters, campaign) {
  return JSON.stringify({characters:(characters || []).map(c => ({
    id:c.id,name:c.name,class:c.class,species:c.species,subclass:c.subclass,level:c.level,
    spells:c.spells,features:c.features,inventory:c.inventory,homebrew:c.homebrew
  })),campaignId:campaign?.id,mechanicsLockedAt:campaign?.mechanicsLockedAt,
  settings:campaign?.settings,permissions:campaign?.permissions});
}
function operationError(op, draft, locked) {
  if (!op || typeof op !== 'object' || typeof op.value !== 'string' ||
      !op.value.trim() || op.value.length > 4000) return 'requires nonempty text under 4000 characters.';
  if (op.op === 'replace' && op.section === 'homebrew' && HOMEBREW_FIELDS.has(op.field)) {
    draft.homebrew ||= {};
    draft.homebrew[op.field] = op.value.trim();
    return null;
  }
  if (op.op === 'replace' && IDENTITY_FIELDS.has(op.section) && !op.field) {
    if (locked) return 'mechanics are locked by the campaign.';
    draft[op.section] = op.value.trim();
    return null;
  }
  if (!ARRAYS.has(op.section) || !Array.isArray(draft[op.section])) return 'unsupported operation or section.';
  if (locked) return 'mechanics are locked by the campaign.';
  const target=draft[op.section];
  const index=indexOfText(target, op.op === 'edit' ? op.previous || '' : op.value);
  const duplicate=indexOfText(target,op.value);
  switch(op.op){
    case 'add':
      if (duplicate >= 0) return 'entry already exists.';
      target.push(op.value.trim());return null;
    case 'remove':
      if (index < 0) return 'entry does not exist.';
      target.splice(index,1);return null;
    case 'edit':
      if (typeof op.previous !== 'string' || !op.previous.trim() || index < 0) return 'original entry does not exist.';
      if (duplicate >= 0 && duplicate !== index) return 'replacement would create a duplicate.';
      target[index]=op.value.trim();return null;
    case 'move':{
      if (!ARRAYS.has(op.from) || op.from === op.section || !Array.isArray(draft[op.from])) return 'invalid source section.';
      if (duplicate >= 0) return 'entry already exists in destination.';
      const oldIndex=indexOfText(draft[op.from],op.value);
      if (oldIndex < 0) return 'source entry does not exist.';
      draft[op.from].splice(oldIndex,1);target.push(op.value.trim());return null;
    }
    default:return 'unsupported operation.';
  }
}
export function validateCodexProposal(proposal, character, characters, campaign, revision) {
  const errors=[];
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) errors.push('Invalid AI response.');
  if (revision !== partyRevision(characters,campaign)) errors.push('Party or campaign changed since this draft. Regenerate it.');
  if (!character?.id || !(characters || []).some(c=>c.id===character.id)) errors.push('Character is not in the current party.');
  if (proposal?.compatible !== true) errors.push('AI has not confirmed compatibility with current party rules.');
  if (typeof proposal?.compatibilityReason !== 'string' || proposal.compatibilityReason.trim().length < 12)
    errors.push('A specific party compatibility explanation is required.');
  const operations=proposal?.operations;
  if (!Array.isArray(operations) || operations.length < 1 || operations.length > 12)
    errors.push('Provide 1 to 12 proposed changes.');
  else if (character) {
    const draft=clone(character);
    const locked=Boolean(campaign?.mechanicsLockedAt || character.mechanicsState==='locked');
    for (const [index,op] of operations.entries()) {
      const error=operationError(op,draft,locked);
      if (error) errors.push('Change '+(index+1)+': '+error);
    }
  }
  return {ok:errors.length===0,errors};
}
export function previewCodexChanges(proposal, character) {
  const operations=Array.isArray(proposal?.operations)?proposal.operations:[];
  return operations.filter(op=>op && typeof op==='object').map(op=>{
    const path=op.op==='move' ? op.from+' → '+op.section : op.section==='homebrew' ? 'homebrew.'+op.field : op.section;
    const before=op.op==='add'?null:op.op==='edit'?op.previous:op.op==='move'||op.op==='remove'?op.value:op.section==='homebrew'?character.homebrew?.[op.field]:character[op.section];
    return {path,action:op.op,before:before??'',after:op.op==='remove'?'(removed)':op.value};
  });
}
export function applyCodexProposal(proposal, character, characters, campaign, revision) {
  const validation=validateCodexProposal(proposal,character,characters,campaign,revision);
  if (!validation.ok) throw new Error(validation.errors.join(' '));
  const next=clone(character);
  for(const op of proposal.operations) {
    const error=operationError(op,next,false);
    if(error)throw new Error(error);
  }
  return next;
}
