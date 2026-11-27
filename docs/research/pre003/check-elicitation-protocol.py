import subprocess,json,selectors,time,os,shutil,tempfile
from pathlib import Path
NODE=os.environ.get('NODE_EXE') or shutil.which('node');SERVER=str(Path(__file__).with_name('elicitation-probe.cjs').resolve())
if not NODE:raise SystemExit('Set NODE_EXE or add node to PATH.')
LAB=Path(tempfile.mkdtemp(prefix='agent-guard-elicitation-'))
class Client:
 def __init__(self):
  self.p=subprocess.Popen([NODE,SERVER],cwd=LAB,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
  self.send({'id':0,'method':'initialize','params':{'capabilities':{'elicitation':{'form':{}}}}});assert self.read()['id']==0
 def send(self,m): self.p.stdin.write(json.dumps({'jsonrpc':'2.0',**m})+'\n');self.p.stdin.flush()
 def read(self,timeout=12):
  s=selectors.DefaultSelector();s.register(self.p.stdout,selectors.EVENT_READ)
  assert s.select(timeout),'no protocol response';s.close();return json.loads(self.p.stdout.readline())
 def call(self,id=1,args=None):
  self.send({'id':id,'method':'tools/call','params':{'name':'guard_probe_confirm','arguments':args or {'command':'rm -- sample.txt','cwd':'/tmp/fixture'}}});return self.read()
 def close(self): self.p.stdin.close();self.p.wait(timeout=3)
results=[]
def outcome(m):return json.loads(m['result']['content'][0]['text'])
for choice,expected in [('allow_once','allowed_simulation'),('deny','denied'),('decline','declined'),('cancel','cancelled'),('error','confirmation_error')]:
 c=Client();f=c.call();rid=f['id'];
 if choice=='error':c.send({'id':rid,'error':{'code':-32603,'message':'test channel error'}})
 else:c.send({'id':rid,'result':{'action':choice if choice in ['decline','cancel'] else 'accept','content':{'decision':choice,'command':'CHANGED','cwd':'/different'}}})
 o=outcome(c.read());assert o['outcome']==expected and not o['executed'];assert o['action']['command']=='rm -- sample.txt' and o['action']['cwd']=='/tmp/fixture';c.close();results.append({'case':choice,'result':expected})
c=Client();m=c.call(args={'command':'test','cwd':'/tmp/fixture','user_approved':True});assert outcome(m)['outcome']=='invalid_arguments';c.close();results.append({'case':'agent supplied approval','result':'invalid_arguments'})
c=Client();f=c.call();c.send({'method':'notifications/cancelled','params':{'requestId':1}});assert outcome(c.read())['outcome']=='cancelled';c.close();results.append({'case':'call cancellation','result':'cancelled'})
c=Client();f=c.call();c.p.stdin.close();m=c.read();assert outcome(m)['outcome']=='connection_closed';c.p.wait(timeout=3);results.append({'case':'stdin EOF','result':'connection_closed'})
c=Client();f=c.call();c.send({'id':f['id'],'result':{'action':'accept','content':{'decision':'allow_once'}}});a=outcome(c.read());g=c.call(2);assert f['id']!=g['id'];c.send({'id':f['id'],'result':{'action':'accept','content':{'decision':'allow_once'}}});c.send({'id':g['id'],'result':{'action':'accept','content':{'decision':'deny'}}});b=outcome(c.read());assert a['action']['actionId']!=b['action']['actionId'] and b['outcome']=='denied';c.close();results.append({'case':'repeat/replay','result':'new action; old response ignored'})
c=Client();f=c.call();c.send({'id':'wrong-id','result':{'action':'accept','content':{'decision':'allow_once'}}});m=outcome(c.read());assert m['outcome']=='no_answer' and not m['executed'];c.close();results.append({'case':'wrong response ID/no answer','result':'no_answer'})
(LAB/'probe-checks-results.json').write_text(json.dumps(results,indent=2))
print('Evidence directory:',LAB);print(json.dumps(results,indent=2));print('PASS',len(results),'protocol simulations; no human approval or execution claimed')
