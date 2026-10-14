#!/usr/bin/env python3
"""Run content-free timings for the isolated KittenTTS 2 C++ CLI backend."""
import argparse,csv,json,os,re,subprocess,time,uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'artifacts/tts-audit'
TEXTS={73:'A lantern glows beside the bridge. Rain taps softly. Bells mark the hour.',174:'The innkeeper glances toward the shuttered window. “Three riders came before dawn,” she says. “They had no crest, and their horses were bleeding.” The fire snaps between you.',475:'At the edge of the marsh, a narrow path disappears beneath black water and silver reeds. The guide stops, listening. Somewhere beyond the fog, a bell rings once, then again. No village stands on this side of the river. The sound is close enough to stir the mud beneath your boots. She raises one hand and whispers for the party to stay together. A pale light moves between the trees, pauses, and turns toward the road. The guide draws a small knife and waits for your answer.'}
def rss_kb(pid):
 try:
  for line in open(f'/proc/{pid}/status'):
   if line.startswith('VmRSS:'):return int(line.split()[1])
 except OSError:pass
 return 0
def parse_reports(raw):
 dec=json.JSONDecoder();pos=0;out=[]
 while pos<len(raw):
  while pos<len(raw) and raw[pos].isspace():pos+=1
  if pos==len(raw):break
  item,pos=dec.raw_decode(raw,pos);out.append(item)
 return out
def percentile(values,q):
 vals=sorted(values)
 return vals[min(len(vals)-1,max(0,int(__import__('math').ceil(q*len(vals))-1)))] if vals else None
def main():
 ap=argparse.ArgumentParser();ap.add_argument('--binary',default=os.getenv('LANTERN_KITTEN_CPP_BIN',''));ap.add_argument('--threads',default='6');ap.add_argument('--thread-sweep',default='1,12');ap.add_argument('--repetitions',type=int,default=3);ap.add_argument('--cache-dir');args=ap.parse_args()
 if not args.binary or not Path(args.binary).is_file():raise SystemExit('Set LANTERN_KITTEN_CPP_BIN or pass --binary to a built kitten-tts executable.')
 configs=[(size,int(args.threads)) for size in TEXTS]+[(73,int(v)) for v in args.thread_sweep.split(',') if v.strip() and int(v)!=int(args.threads)]
 rows=[];events=[]
 for size,threads in configs:
  run_id=str(uuid.uuid4());log_base=f'lantern-tts-audit-{run_id}';stdout=Path('/tmp')/(log_base+'.out');stderr=Path('/tmp')/(log_base+'.err');wav=Path('/tmp')/(log_base+'.wav')
  cmd=[args.binary,'--text',TEXTS[size],'--voice','Bruno','--threads',str(threads),'--decoder-threads',str(threads),'--seed','1234','--repeat',str(args.repetitions),'--output',str(wav)]
  if args.cache_dir:cmd.extend(['--cache-dir',args.cache_dir])
  started=time.perf_counter_ns()
  with stdout.open('w') as out,stderr.open('w') as err:
   proc=subprocess.Popen(cmd,stdout=out,stderr=err);peak=0
   while proc.poll() is None:peak=max(peak,rss_kb(proc.pid));time.sleep(.2)
  wall_ms=(time.perf_counter_ns()-started)/1e6;reports=parse_reports(stdout.read_text());err=stderr.read_text();load_matches=re.findall(r'load time\s*=\s*([0-9.]+) ms',err);context_report_ms=float(load_matches[-1]) if load_matches else None
  stage_total=sum((float(r.get('lm_seconds',0))+float(r.get('decoder_seconds',0)))*1000 for r in reports)
  startup_overhead=max(0,wall_ms-stage_total)
  events.append({'event':'cpp_process_complete','mono_ns':time.perf_counter_ns(),'correlation_id':run_id,'model':'KittenTTS2-C++-TQ2_1','sample_chars':size,'threads':threads,'exit_code':proc.returncode,'process_wall_ms':round(wall_ms,3),'process_startup_overhead_ms':round(startup_overhead,3),'llama_context_report_ms':context_report_ms,'peak_rss_mb':round(peak/1024,1),'iterations':len(reports),'cache':'hit' if not args.cache_dir else 'configured','text_saved':False})
  for report in reports:
   generation_ms=(float(report.get('lm_seconds',0))+float(report.get('decoder_seconds',0)))*1000
   rows.append({'model':'kitten2-cpp-tq2_1','scenario':'isolated','warmth':'first_after_load' if report.get('iteration')==1 else 'warm','cache':'hit' if not args.cache_dir else 'configured','sample_chars':size,'rep':report.get('iteration'),'status':'ok' if proc.returncode==0 else 'error','load_ms':'','process_startup_overhead_ms':round(startup_overhead,3) if report.get('iteration')==1 else 0,'inference_ms':round(generation_ms,3),'request_ms':round(generation_ms,3),'ttfas_ms':'','audio_ms':round(float(report.get('audio_seconds',0))*1000,3),'rtf':report.get('rtf'),'peak_memory_mb':round(peak/1024,1),'device':'cpu','cuda_available':False,'cpu_fallback':False,'runtime_threads':threads,'decoder_threads':threads,'quality_notes':'Not human-rated; fixed synthetic text.'})
   events.append({'event':'cpp_benchmark_iteration','mono_ns':time.perf_counter_ns(),'correlation_id':f'{run_id}-{report.get("iteration")}','model':'KittenTTS2-C++-TQ2_1',**rows[-1]})
  stdout.unlink(missing_ok=True);stderr.unlink(missing_ok=True);wav.unlink(missing_ok=True)
 # Add group percentiles to each row; p95 uses nearest-rank over the three fixed repeats.
 for row in rows:
  group=[r for r in rows if r['sample_chars']==row['sample_chars'] and r['runtime_threads']==row['runtime_threads']]
  row['p50_generation_ms']=round(percentile([r['inference_ms'] for r in group],.5),3)
  row['p95_generation_ms']=round(percentile([r['inference_ms'] for r in group],.95),3)
  row['p50_rtf']=round(percentile([r['rtf'] for r in group],.5),3)
  row['p95_rtf']=round(percentile([r['rtf'] for r in group],.95),3)
 csv_path=OUT/'benchmarks.csv';base=list(csv.DictReader(csv_path.open())) if csv_path.exists() else [];base=[r for r in base if r.get('model')!='kitten2-cpp-tq2_1'];combined=base+rows;columns=sorted({k for r in combined for k in r})
 with csv_path.open('w',newline='') as f:w=csv.DictWriter(f,fieldnames=columns);w.writeheader();w.writerows(combined)
 with (OUT/'timings.jsonl').open('a') as f:
  for event in events:f.write(json.dumps(event,separators=(',',':'))+'\n')
 print(f'Wrote {len(rows)} C++ measurement rows to {csv_path}')
if __name__=='__main__':main()
