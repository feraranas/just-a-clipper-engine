from pathlib import Path
import subprocess,json,wave,array,math,shutil,argparse
parser=argparse.ArgumentParser(description='Prepare the approved presenter comparison with local Mac speech.')
parser.add_argument('--reference',required=True,type=Path)
args=parser.parse_args()
if not args.reference.is_file():parser.error('Presenter reference image does not exist')
root=Path(__file__).resolve().parent.parent;assets=root/'public/generated/presenter-demo'
assets.mkdir(parents=True,exist_ok=True)
(root/'src/PresenterDemo').mkdir(parents=True,exist_ok=True)
parts=[
'Your coding agent is about to run a command. How do you decide whether to let it?',
'A blocklist checks for commands you already marked as dangerous.',
'An intent check asks a different question: what could this action change, and how difficult would it be to undo?',
'Take a force push. It can overwrite shared Git history. A small classifier can flag that consequence before execution.',
'Your application then applies the rule: allow, block, or ask you.',
'The classifier can be wrong. Keep permission limits and human approval around consequential actions.',
'Use the model to assess risk. Keep the rules in code.'
]
timings=[];cursor=0
for i,text in enumerate(parts):
 a=assets/f'part-{i}.aiff';w=assets/f'part-{i}.wav'
 subprocess.run(['say','-v','Samantha','-r','175','-o',str(a),text],check=True)
 subprocess.run(['ffmpeg','-v','error','-y','-i',str(a),'-ar','24000','-ac','1','-c:a','pcm_s16le',str(w)],check=True)
 with wave.open(str(w)) as f:duration=f.getnframes()/f.getframerate()
 timings.append({'text':text,'start':cursor,'end':cursor+duration});cursor+=duration
(assets/'concat.txt').write_text(''.join(f"file 'part-{i}.wav'\n" for i in range(len(parts))))
subprocess.run(['ffmpeg','-v','error','-y','-f','concat','-safe','0','-i',str(assets/'concat.txt'),'-c:a','pcm_s16le',str(assets/'narration.wav')],check=True)
with wave.open(str(assets/'narration.wav')) as f:
 rate=f.getframerate();samples=array.array('h',f.readframes(f.getnframes()))
fps=24;levels=[]
for i in range(math.ceil(cursor*fps)):
 chunk=samples[int(i*rate/fps):int((i+1)*rate/fps)];rms=math.sqrt(sum(x*x for x in chunk)/max(1,len(chunk)))/32768
 levels.append(round(min(1,rms*12),3))
(root/'src/PresenterDemo/timing.json').write_text(json.dumps({'duration':cursor,'fps':fps,'segments':timings,'levels':levels}))
shutil.copyfile(args.reference,assets/'presenter-reference.png')
print(json.dumps({'duration':cursor,'frames':len(levels),'voice':'Samantha','segments':len(parts)}))
