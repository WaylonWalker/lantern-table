// Living Codex AI proposals are never mutations. Apply only after explicit review.
// The current party snapshot acts as a revision lock: stale proposals cannot be applied.
const ARRAYS = new Set(['inventory', 'spells', 'features']);
const HOMEBREW_FIELDS = new Set(['name', 'description', 'traits', 'abilities', 'notes']);
const IDENTITY_FIELDS = new Set(['species', 'class', 'subclass', 'background']);
const copy = value => JSON.parse(JSON.stringify(value));
export function partyRevision(characters, campaign) {
  return JSON.stringify({characters: (characters || []).map(c => ({
    id:c.id, name:c.name, class:c.class, species:c.species, level:c.level,
    spells:c.spells, features:c.features, inventory:c.inventory, homebrew:c.homebrew
  })), campaignId:campaign?.id, mechanicsLockedAt:campaign?.mechanicsLockedAt,
  settings:campaign?.settings, permissions:campaign?.permissions});
}
export function validateCodexProposal(proposal, character, characters, campaign, revision) {
  const errors = [];
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) errors.push('Invalid AI response.');
  if (revision !== partyRevision(characters, campaign)) errors.push('Party or campaign changed since this draft. Regenerate it.');
  if (!character?.id || !(characters || []).some(c => c.id === character.id)) errors.push('Character is not in the current party.');
  if (proposal?.compatible !== true) errors.push('AI has not confirmed compatibility with current party rules.');
  if (typeof proposal?.compatibilityReason !== 'string' || proposal.compatibilityReason.trim().length < 12) errors.push('A specific party compatibility explanation is required.');
  const operations = proposal?.operations;
  if (!Array.isArray(operations) || operations.length < 1 || operations.length > 12) errors.push('Provide 1 to 12 proposed changes.');
  else for (const [index, op] of operations.entries()) {
    const prefix = 'Change ' + (index + 1) + ': ';
    if (!op || typeof op !== 'object' || typeof op.value !== 'string' || !op.value.trim() || op.value.length > 4000) {
      errors.push(prefix + 'requires nonempty text under 4000 characters.'); continue;
    }
    if (op.op === 'add' && ARRAYS.has(op.section)) {
      if (!Array.isArray(character[op.section])) errors.push(prefix + 'character section is not a list.');
      else if (character[op.section].some(v => String(v).toLowerCase() === op.value.trim().toLowerCase())) errors.push(prefix + 'duplicate entry.');
    } else if (op.op === 'replace' && op.section === 'homebrew' && HOMEBREW_FIELDS.has(op.field)) {
      // Free-form homebrew fields are editable without modifying authoritative mechanics.
    } else if (op.op === 'replace' && IDENTITY_FIELDS.has(op.section) && !op.field) {
      if (campaign?.mechanicsLockedAt || character.mechanicsState === 'locked') errors.push(prefix + 'mechanics are locked by the campaign.');
    } else errors.push(prefix + 'unsupported operation/field.');
  }
  return {ok: errors.length === 0, errors};
}
export function previewCodexChanges(proposal, character) {
  return (proposal?.operations || []).map(op => ({
    path: op.section === 'homebrew' ? 'homebrew.' + op.field : op.section,
    action: op.op,
    before: op.op === 'add' ? null : (op.section === 'homebrew' ? character.homebrew?.[op.field] : character[op.section]) ?? '',
    after: op.value
  }));
}
export function applyCodexProposal(proposal, character, characters, campaign, revision) {
  const validation = validateCodexProposal(proposal, character, characters, campaign, revision);
  if (!validation.ok) throw new Error(validation.errors.join(' '));
  const next = copy(character);
  for (const op of proposal.operations) {
    if (op.op === 'add') next[op.section].push(op.value.trim());
    else if (op.section === 'homebrew') next.homebrew[op.field] = op.value.trim();
    else next[op.section] = op.value.trim();
  }
  return next;
}
