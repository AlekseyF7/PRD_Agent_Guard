import json, threading, subprocess, time, sys, os, shutil, tempfile
from pathlib import Path
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
ROOT=Path(os.environ.get('AGENT_GUARD_PROBE_ROOT') or tempfile.mkdtemp(prefix='agent-guard-pre003-')).resolve()
NODE=os.environ.get('NODE_EXE') or shutil.which('node')
CLI=os.environ.get('OPENCODE_BIN') or shutil.which('opencode')
if not CLI or not NODE: raise SystemExit('Set OPENCODE_BIN and NODE_EXE, or add them to PATH.')
SERVER=str(Path(__file__).resolve().parent.parent/'opencode-example/mcp-server.js')
scenario=sys.argv[1] if len(sys.argv)>1 else 'catalog'
folder=ROOT/scenario; folder.mkdir(exist_ok=True)
print('LAB:',folder,flush=True)
(folder/'alternate').mkdir(exist_ok=True)
(ROOT/'outside-fixture').mkdir(exist_ok=True)
(ROOT/'outside-fixture'/'outside.txt').write_text('OUTSIDE-TEST-ONLY\n')
(folder/'sample.txt').write_text('ORIGINAL-test-only\n')
requests=[]
called=0
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args): pass
 def do_POST(self):
  body=json.loads(self.rfile.read(int(self.headers.get('Content-Length','0'))))
  tools=body.get('tools',[])
  if tools:
   (folder/'catalog.json').write_text(json.dumps(tools,indent=2))
  requests.append({'path':self.path,'tool_names':[t.get('function',{}).get('name') for t in tools]})
  global called
  choice=None
  kind=scenario.split('-')[-1]
  args={
   'shell':{'command':'printf CONTROLLED > shell-marker.txt','workdir':str(folder)},
   'write':{'path':str(folder/'blocked.txt'),'content':'CONTROLLED'},
   'edit':{'path':str(folder/'sample.txt'),'oldString':'ORIGINAL-test-only','newString':'MODIFIED-test-only'},
   'read':{'path':str(folder/'sample.txt')},
   'subagent':{'agent':'explore','description':'Permission denial probe','prompt':'Return TEST only.'},
   'execute':{'code':'return "CONTROLLED";'},
   'echo':{'message':'controlled-echo'},
   'other':{'message':'controlled-other-server'},
   'move':{'directory':str(ROOT/'outside-fixture')},
   'moveinside':{'directory':str(folder/'alternate')},
   'readexternal':{'path':str(ROOT/'outside-fixture'/'outside.txt')},
   'resources':{'server':'bypass'}
  }
  tool='guard_test_echo' if kind=='echo' else 'bypass_test_echo' if kind=='other' else 'opencode_session_move' if kind in ['move','moveinside'] else 'read' if kind=='readexternal' else 'opencode_list_mcp_resources' if kind=='resources' else kind
  if tools and called==0 and kind in args:
   called=1;choice={'index':0,'id':'call-probe-1','type':'function','function':{'name':tool,'arguments':json.dumps(args[kind])}}
  elif tools and called==1 and kind=='moveinside':
   called=2;choice={'index':0,'id':'call-probe-2','type':'function','function':{'name':'shell','arguments':json.dumps({'command':'printf CONTROLLED > shell-marker.txt','workdir':str(folder/'alternate')})}}
  delta={'role':'assistant','tool_calls':[choice]} if choice else {'role':'assistant','content':'Controlled probe finished.'}
  finish='tool_calls' if choice else 'stop'
  if body.get('stream'):
   payload=[{'id':'probe-local','object':'chat.completion.chunk','created':int(time.time()),'model':'probe','choices':[{'index':0,'delta':delta,'finish_reason':None}]},{'id':'probe-local','object':'chat.completion.chunk','created':int(time.time()),'model':'probe','choices':[{'index':0,'delta':{},'finish_reason':finish}],'usage':{'prompt_tokens':1,'completion_tokens':1,'total_tokens':2}}]
   data=(''.join('data: '+json.dumps(x)+'\n\n' for x in payload)+'data: [DONE]\n\n').encode(); content_type='text/event-stream'
  else:
   msg={'role':'assistant','content':None,'tool_calls':[choice]} if choice else delta
   data=json.dumps({'id':'probe-local','object':'chat.completion','created':int(time.time()),'model':'probe','choices':[{'index':0,'message':msg,'finish_reason':finish}],'usage':{'prompt_tokens':1,'completion_tokens':1,'total_tokens':2}}).encode();content_type='application/json'
  self.send_response(200);self.send_header('Content-Type',content_type);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)

server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
config={'providers':{'probe':{'name':'Local controlled research model','env':[],'package':'@opencode/ai/providers/openai-compatible','settings':{'apiKey':'local-test-not-secret','baseURL':f'http://127.0.0.1:{server.server_port}/v1'},'models':{'probe':{'name':'Probe'}}}},'permissions':[{'action':'*','resource':'*','effect':'allow'}],'mcp':{'servers':{'guard':{'type':'local','command':[NODE,SERVER],'codemode':False}}}}
config['mcp']['servers']['bypass']=dict(config['mcp']['servers']['guard'])
if scenario.startswith('deny-'):
 config['permissions'].append({'action':'execute','resource':'*','effect':'deny'})
 config['policies']=[{'action':'tool.use','resource':'*','effect':'deny'},{'action':'tool.use','resource':'read:*','effect':'allow'},{'action':'tool.use','resource':'guard_test_echo:*','effect':'allow'}]
(folder/'opencode.json').write_text(json.dumps(config,indent=2))
os.environ['PWD']=str(folder)
try:
 r=subprocess.run([CLI,'run','--standalone','--model','probe/probe','--agent','build','--format','json','Local research: answer with the test response only.'],cwd=folder,capture_output=True,text=True,timeout=60)
 (folder/'cli.jsonl').write_text(r.stdout);(folder/'stderr.txt').write_text(r.stderr)
 print('exit:',r.returncode,'requests:',len(requests)); print(r.stdout[-3500:]);print(r.stderr[-1000:])
 print('SAMPLE:',(folder/'sample.txt').read_text().strip(),'WRITE:',(folder/'blocked.txt').exists(),'SHELL:',(folder/'shell-marker.txt').exists())
 if (folder/'catalog.json').exists():
  tools=json.loads((folder/'catalog.json').read_text());print('TOOLS:',[t['function']['name'] for t in tools])

finally: server.shutdown()
