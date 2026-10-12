export const SPEECH_EMOTIONS = Object.freeze(['angry','contemplative','excited','joyful','mundane','nervous','sad','stern','surprised','tender']);
export const SPEECH_EVENTS = Object.freeze(['gasp','giggle','growl','gulp','laugh','pause','scoff','sigh','sob','um']);

export function normalizeSpeech(value = {}) {
  const parts = Array.isArray(value.parts) ? value.parts.slice(0, 80).flatMap(part => {
    if (part?.type === 'text' && typeof part.text === 'string') return [{type:'text', text:part.text.slice(0,4000)}];
    if (part?.type === 'emphasis' && typeof part.text === 'string') return [{type:'emphasis', text:part.text.slice(0,240)}];
    if (part?.type === 'event' && SPEECH_EVENTS.includes(part.event)) return [{type:'event',event:part.event}];
    return [];
  }) : [{type:'text',text:String(value.text||'').slice(0,8000)}];
  return {utterance_id:String(value.utterance_id||''),message_id:String(value.message_id||''),speaker_id:String(value.speaker_id||''),emotion:SPEECH_EMOTIONS.includes(value.emotion)?value.emotion:null,energy:Number.isFinite(+value.energy)?Math.max(0,Math.min(1,+value.energy)):0.5,parts};
}

export function speechPlainText(value) { return normalizeSpeech(value).parts.map(p=>p.type==='event'?'':p.text).join(''); }

export function compileKittenSpeech(value) {
  const speech=normalizeSpeech(value);
  const body=speech.parts.map(p=>p.type==='event'?` <${p.event}>`:p.type==='emphasis'?`(((${p.text})))`:p.text).join('').trim();
  return `${speech.emotion?`[${speech.emotion}] `:''}${body}`;
}

export function renderSpeechParts(value) {
  const speech=normalizeSpeech(value);
  return speech.parts.map(p=>p.type==='event'?`<span class="speech-event" aria-label="${p.event}">${({gasp:'gasps',giggle:'giggles',growl:'growls',gulp:'gulps',laugh:'laughs',pause:'',scoff:'scoffs',sigh:'sighs',sob:'sobs',um:'hesitates'})[p.event]}</span>`:p.type==='emphasis'?`<strong class="speech-emphasis">${escapeHtml(p.text)}</strong>`:escapeHtml(p.text)).join('');
}

export function assignVoice(catalogue, characters, character, traits='') {
  const languageVoices=new Set(['Arabic','Chinese','French','German','Hindi','Italian','Portuguese','Russian','Spanish']);
  const voices=(catalogue||[]).filter(v=>typeof v==='string'?!languageVoices.has(v):(v?.language||'en')==='en');
  if(!voices.length)return null;
  const used=new Set((characters||[]).filter(c=>c!==character).map(c=>c.voice?.voice_id).filter(Boolean));
  const available=voices.filter(v=>!used.has(typeof v==='string'?v:v.id));
  const voice=(available.length?available:voices)[Math.floor(Math.random()*(available.length||voices.length))];
  const id=typeof voice==='string'?voice:voice.id;
  const text=String(traits||'').toLowerCase();
  const base_energy=/booming|bold|animated|energetic|fiery/.test(text)?0.78:/soft|reserved|quiet|restrained|deliberate/.test(text)?0.38:0.58;
  const expressiveness=/stoic|controlled|restrained|guarded/.test(text)?0.34:/animated|dramatic|volatile|expressive/.test(text)?0.82:0.62;
  return {engine:'kitten2',voice_id:id,language:typeof voice==='string'?'en':voice.language||'en',base_energy,expressiveness,delivery_style:'',assigned_at_creation:true};
}

export function escapeHtml(value) { return String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
