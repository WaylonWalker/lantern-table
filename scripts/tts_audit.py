#!/usr/bin/env python3
"""Repeatable local TTS measurements; all requests contain fixed synthetic text only."""
import argparse,csv,json,os,platform,subprocess,sys,time,shutil
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]; OUT=ROOT/'artifacts/tts-audit'
TEXTS={73:'A lantern glows beside the bridge. Rain taps softly. Bells mark the hour.',174:'The innkeeper glances toward the shuttered window. “Three riders came before dawn,” she says. “They had no crest, and their horses were bleeding.” The fire snaps between you.',450:'At the edge of the marsh, a narrow path disappears beneath black water and silver reeds. The guide stops, listening. Somewhere beyond the fog, a bell rings once, then again. No village stands on this side of the river. The sound is close enough to stir the mud beneath your boots. She raises one hand and whispers for the party to stay together. A pale light moves between the trees, pauses, and turns toward the road. The guide draws a small knife and waits for your answer.'}
MODELS=['kitten2-emb4','kitten-mini-80m','kitten-micro-40m']
def run(cmd,timeout=20):
 try:return subprocess.run(cmd,text=True,capture_output=True,timeout=timeout).stdout.strip()
 except Exception as e:return f'unavailable: {type(e).__name__}: {e}'
def write_runtime():
 gpu=run(['nvidia-smi','--query-gpu=name,driver_version,memory.total,memory.used,utilization.gpu,utilization.memory','--format=csv,noheader']) if shutil.which('nvidia-smi') else 'unavailable'
 try:
  mem=Path('/proc/meminfo').read_text().splitlines()[:3]
  mem='; '.join(mem)
 except:mem='unavailable'
 data={'captured_at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'platform':platform.platform(),'machine':platform.machine(),'processor':platform.processor(),'logical_cpus':os.cpu_count(),'python':sys.version,'gpu_snapshot':gpu,'memory_snapshot':mem,'omp_num_threads':os.getenv('OMP_NUM_THREADS'),'mkl_num_threads':os.getenv('MKL_NUM_THREADS'),'torch_installed':run([sys.executable,'-c','import torch;print(torch.__version__,torch.cuda.is_available(),torch.get_num_threads())'],10),'browser': 'Not measured by CLI; use browser capture instructions in summary.md'}
 (OUT/'runtime.md').write_text('# Runtime diagnostics\n\n```json\n'+json.dumps(data,indent=2)+'\n```\n\nGPU utilization and memory are a single idle-time snapshot; capture concurrently with synthesis for active values. Worker-reported CUDA and device are recorded per request when a model loads.\n')
def persist(records,events):
 cols=['model','scenario','warmth','cache','sample_chars','rep','status','load_ms','warmup_ms','inference_ms','request_ms','ttfas_ms','audio_ms','rtf','peak_memory_mb','device','cuda_available','cpu_fallback','torch_threads','torch_interop_threads','error','notes']
 cols+=sorted({k for row in records for k in row}-set(cols))
 with (OUT/'benchmarks.csv').open('w',newline='') as f:
  w=csv.DictWriter(f,fieldnames=cols);w.writeheader();w.writerows(records)
 with (OUT/'timings.jsonl').open('w') as f:
  for event in events:f.write(json.dumps(event,separators=(',',':'))+'\n')
def main():
 ap=argparse.ArgumentParser();ap.add_argument('--models',default=','.join(MODELS));ap.add_argument('--repetitions',type=int,default=3);ap.add_argument('--bridge',default='http://127.0.0.1:8768');args=ap.parse_args()
 import urllib.request,urllib.error,uuid
 OUT.mkdir(parents=True,exist_ok=True);(OUT/'logs').mkdir(exist_ok=True);write_runtime();records=[];events=[]
 status={}
 try:
  for _ in range(150):
   with urllib.request.urlopen(args.bridge+'/api/kitten/status',timeout=3) as r:status=json.load(r)
   if status.get('loaded') or status.get('state')=='error':break
   time.sleep(1)
 except Exception as e: status={'available':False,'error':str(e)}
 if status.get('loaded'):
  startup={'model':'kitten2-emb4','scenario':'worker_startup','warmth':'cold','cache':'n/a','sample_chars':0,'rep':1,'status':'ok','load_ms':status.get('load_ms'),'warmup_ms':status.get('warmup_ms'),'device':status.get('device'),'cuda_available':status.get('cuda_available'),'cpu_fallback':status.get('cpu_fallback'),'torch_threads':status.get('torch_threads')}
  records.append(startup);events.append({'event':'worker_startup_observed','mono_ns':time.perf_counter_ns(),**startup})
  persist(records,events)
 for model in args.models.split(','):
  model=model.strip()
  if model!='kitten2-emb4':
   records.append({'model':model,'scenario':'isolated','warmth':'not_run','cache':'n/a','status':'not_run','error':'Alternative models require a separate model-specific worker; this runner currently measures the active companion model only.'});persist(records,events);continue
  if not status.get('loaded'):
   records.append({'model':model,'scenario':'isolated','warmth':'unavailable','cache':'n/a','status':'unavailable','error':status.get('error') or 'No loaded local companion at '+args.bridge});persist(records,events);continue
  for size,text in TEXTS.items():
   for rep in range(1,args.repetitions+1):
    # Distinct energy values force three cache misses; repeat each request to measure the cache hit.
    energy=.45+rep*.01; correlation=str(uuid.uuid4());payload={'text':text,'voice':(status.get('voices') or ['Matthew'])[0],'energy':energy,'preset':'stable'}
    for cache_mode in ('miss','hit'):
     cid=correlation if cache_mode=='miss' else str(uuid.uuid4());body=json.dumps({**payload,'correlation_id':cid}).encode();req=urllib.request.Request(args.bridge+'/api/kitten/synthesize',data=body,headers={'Content-Type':'application/json','X-Lantern-Correlation-Id':cid})
     started=time.perf_counter_ns()
     try:
      with urllib.request.urlopen(req,timeout=600) as response:
       audio=response.read();elapsed=(time.perf_counter_ns()-started)/1e6;headers=response.headers
      row={'model':model,'scenario':'isolated','warmth':'warm' if status.get('loaded') else 'cold','cache':cache_mode,'sample_chars':size,'rep':rep,'status':'ok','load_ms':status.get('load_ms'),'warmup_ms':status.get('warmup_ms'),'inference_ms':float(headers.get('X-Generation-Ms','0')),'request_ms':elapsed,'audio_ms':float(headers.get('X-Audio-Duration-Ms','0')),'rtf':float(headers.get('X-Generation-Ms','0'))/max(1,float(headers.get('X-Audio-Duration-Ms','1'))),'response_bytes':len(audio),'peak_memory_mb':None,'device':headers.get('X-Kitten-Device'),'cuda_available':status.get('cuda_available'),'cpu_fallback':status.get('cpu_fallback'),'torch_threads':status.get('torch_threads')}
     except KeyboardInterrupt:
      row={'model':model,'scenario':'isolated','warmth':'warm','cache':cache_mode,'sample_chars':size,'rep':rep,'status':'censored','elapsed_lower_bound_ms':round((time.perf_counter_ns()-started)/1e6),'error':'Interrupted before response; no completed latency.'}
      records.append(row);events.append({'event':'request_censored','mono_ns':time.perf_counter_ns(),'correlation_id':cid,**row,'text_logged':False});persist(records,events);print(f'Wrote partial audit ({len(records)} rows) to {OUT}');return
     except Exception as e:row={'model':model,'scenario':'isolated','warmth':'warm','cache':cache_mode,'sample_chars':size,'rep':rep,'status':'error','error':str(e)[:300]}
     records.append(row);events.append({'event':'benchmark_request','mono_ns':time.perf_counter_ns(),'correlation_id':cid,**row})
     persist(records,events)
 (OUT/'traces/browser-performance.jsonl').write_text('# Browser trace capture is opt-in: open the local app with ?ttsAudit=1 and save console entries beginning [Lantern TTS Audit]. Entries contain stage timings and opaque IDs only. No dialogue is logged.\n')
 (OUT/'logs/bridge-worker.jsonl').write_text('# Set LANTERN_TTS_AUDIT_LOG to this path before starting the companion. Content-free stage events are written only when the opt-in variable is set.\n')
 (OUT/'logs/worker-status.json').write_text(json.dumps({k:status.get(k) for k in ('model','weights','device','cuda_available','cpu_fallback','load_ms','warmup_ms','warmup_error','torch_threads','torch_interop_threads')},indent=2)+'\n')
 print(f'Wrote {len(records)} rows to {OUT}')
if __name__=='__main__':main()
