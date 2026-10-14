#!/usr/bin/env python3
"""Measure fixed, synthetic text with Kitten Mini 80M and Micro 40M."""
import argparse,csv,json,os,subprocess,sys,time,uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'artifacts/tts-audit'
TEXTS={73:'A lantern glows beside the bridge. Rain taps softly. Bells mark the hour.',174:'The innkeeper glances toward the shuttered window. “Three riders came before dawn,” she says. “They had no crest, and their horses were bleeding.” The fire snaps between you.',475:'At the edge of the marsh, a narrow path disappears beneath black water and silver reeds. The guide stops, listening. Somewhere beyond the fog, a bell rings once, then again. No village stands on this side of the river. The sound is close enough to stir the mud beneath your boots. She raises one hand and whispers for the party to stay together. A pale light moves between the trees, pauses, and turns toward the road. The guide draws a small knife and waits for your answer.'}
MODELS={'kitten-mini-80m':'KittenML/kitten-tts-mini-0.8','kitten-micro-40m':'KittenML/kitten-tts-micro-0.8'}
def percentile(values,q):
 import math
 return sorted(values)[min(len(values)-1,max(0,math.ceil(q*len(values))-1))]
def child(model):
 import gc,resource
 from kittenml import KittenTTS
 repo=MODELS[model];cache_root=Path(os.getenv('HF_HUB_CACHE',Path.home()/'.cache/huggingface/hub'));cache_miss=not (cache_root/f'models--{repo.replace("/","--")}').exists()
 t=time.perf_counter_ns();tts=KittenTTS(repo);load_ms=(time.perf_counter_ns()-t)/1e6
 providers=tts.model.session.get_providers();rows=[]
 for size,text in TEXTS.items():
  for rep in range(1,4):
   started=time.perf_counter_ns();audio=tts.generate(text=text,voice='Bruno');generation_ms=(time.perf_counter_ns()-started)/1e6;audio_ms=len(audio)/24000*1000
   rows.append({'model':model,'scenario':'isolated','warmth':'warm','cache':'miss' if cache_miss else 'hit','sample_chars':size,'rep':rep,'status':'ok','load_ms':round(load_ms,3) if size==73 and rep==1 else 0,'inference_ms':round(generation_ms,3),'request_ms':round(generation_ms,3),'audio_ms':round(audio_ms,3),'rtf':generation_ms/audio_ms if audio_ms else None,'device':'cpu','execution_providers':providers,'peak_memory_mb':round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1024,1),'thread_settings':'ONNX Runtime defaults','quality_notes':'Not human-rated; fixed synthetic text.'})
  gc.collect()
 event={'event':'alternative_model_ready','mono_ns':time.perf_counter_ns(),'model':model,'repo':repo,'load_ms':round(load_ms,3),'providers':providers,'cache':'miss' if cache_miss else 'hit','runtime_threads':'ONNX Runtime defaults','peak_memory_mb':round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1024,1),'text_logged':False}
 print(json.dumps({'event':event,'rows':rows},separators=(',',':')))
def main():
 ap=argparse.ArgumentParser();ap.add_argument('--model',choices=list(MODELS));args=ap.parse_args();OUT.mkdir(parents=True,exist_ok=True)
 if args.model:
  child(args.model);return
 allrows=[];events=[]
 for model in MODELS:
  proc=subprocess.run([sys.executable,__file__,'--model',model],text=True,capture_output=True,check=True);json_lines=[line for line in proc.stdout.splitlines() if line.lstrip().startswith('{')];data=json.loads(json_lines[-1]);events.append(data['event']);rows=data['rows']
  for row in rows:
   group=[x for x in rows if x['sample_chars']==row['sample_chars']]
   row['p50_generation_ms']=round(percentile([x['inference_ms'] for x in group],.5),3);row['p95_generation_ms']=round(percentile([x['inference_ms'] for x in group],.95),3);row['p50_rtf']=round(percentile([x['rtf'] for x in group],.5),3);row['p95_rtf']=round(percentile([x['rtf'] for x in group],.95),3)
  allrows+=rows
  for row in rows:events.append({'event':'benchmark_request','mono_ns':time.perf_counter_ns(),'correlation_id':str(uuid.uuid4()),**{k:v for k,v in row.items() if k not in ('quality_notes',)}})
 p=OUT/'benchmarks.csv';base=list(csv.DictReader(p.open())) if p.exists() else [];base=[r for r in base if r.get('model') not in MODELS];combined=base+allrows;columns=sorted({k for r in combined for k in r})
 with p.open('w',newline='') as f:w=csv.DictWriter(f,fieldnames=columns);w.writeheader();w.writerows(combined)
 with (OUT/'timings.jsonl').open('a') as f:
  for event in events:f.write(json.dumps(event,separators=(',',':'))+'\n')
 print(f'Wrote {len(allrows)} alternative-model rows to {p}')
if __name__=='__main__':main()
