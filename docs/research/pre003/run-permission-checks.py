import subprocess,json,concurrent.futures,os,tempfile
from pathlib import Path
ROOT=Path(tempfile.mkdtemp(prefix='agent-guard-pre003-suite-')).resolve()
os.environ['AGENT_GUARD_PROBE_ROOT']=str(ROOT)
print('Evidence directory:',ROOT,flush=True)
PROBE=Path(__file__).with_name('controlled-model-probe.py')
cases=['allow-shell','allow-write','allow-edit','allow-other','deny-shell','deny-write','deny-edit','deny-subagent','deny-execute','deny-other','deny-move','deny-moveinside','deny-readexternal','deny-resources','deny-read','deny-echo']
def run(case):
 r=subprocess.run([__import__('sys').executable,'-B',str(PROBE),case],capture_output=True,text=True,timeout=80)
 (ROOT/(case+'-runner.txt')).write_text(r.stdout+r.stderr)
 p=ROOT/case; events=[json.loads(l) for l in (p/'cli.jsonl').read_text().splitlines() if l.strip()]
 tools=[e['part'] for e in events if e.get('type')=='tool_use']
 assert r.returncode==0,(case,r.stderr)
 assert len(tools)==(2 if case=='deny-moveinside' else 1),(case,'tool calls',len(tools))
 if case=='deny-moveinside':
  assert tools[0]['state']['status']=='completed'
  assert tools[1]['state']['status']=='error' and 'Blocked by configuration policy' in tools[1]['state'].get('error','')
  assert not (p/'alternate'/'shell-marker.txt').exists()
  return {'case':case,'tool':'opencode_session_move then shell','status':'internal move allowed; shell still blocked','fixture_ok':True}
 st=tools[0]['state'];expected='error' if case.startswith('deny-') and case not in ['deny-read','deny-echo'] else 'completed'
 assert st['status']==expected,(case,st)
 if expected=='error': assert ('No tool named' in st.get('error','') if case=='deny-execute' else 'Blocked by configuration policy' in st.get('error','')),(case,st)
 expected_sample='MODIFIED-test-only' if case=='allow-edit' else 'ORIGINAL-test-only'
 assert (p/'sample.txt').read_text().strip()==expected_sample
 assert (p/'shell-marker.txt').exists()==(case=='allow-shell')
 assert (p/'blocked.txt').exists()==(case=='allow-write')
 return {'case':case,'tool':tools[0]['tool'],'status':st['status'],'error':st.get('error'),'output':st.get('output'),'fixture_ok':True}
results=[]
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
 for f in concurrent.futures.as_completed([pool.submit(run,c) for c in cases]):
  x=f.result();results.append(x);print(json.dumps(x),flush=True)
(ROOT/'suite-results.json').write_text(json.dumps(sorted(results,key=lambda x:x['case']),indent=2))
print('PASS',len(results),flush=True)
